import type { BrowserSession, ChatMessage, Run, RunStep, RuntimeState } from "@swarm/contracts";
import { emptyUsage } from "@swarm/usage";
import { ControlPlaneClient } from "../core/control-plane";
import { LlmCostLedger } from "../llm/cost-ledger";
import { HermesClient } from "../llm/hermes";
import { OpenRouterClient } from "../llm/openrouter";
import { Store } from "../store";
import { SkyvernClient } from "../browser/skyvern";
import { resumeDeferredMail } from "../tasks/inbox";
import { systemPrompt } from "../llm/prompts";
import { redactInternal } from "../core/redact";
import { ensureWorkGuides } from "../onboarding/service-guide";
import { ensureRunId } from "../tasks/service-work";
import { recordUsage, turnDetails, type TaskRef } from "../core/usage";
import type { RuntimeConfig } from "../core/config";
import { log, warn } from "../core/log";
import { Approvals } from "./approvals";
import { BrowserControl } from "./browser";
import { Handoffs } from "./handoffs";
import { newId } from "./ids";
import { Research } from "./research";
import { ServiceCatalog } from "./services";
import { deliverChannelReply } from "../channels/listen";

/** Результат одного хода Hermes: текст + метаданные для проверки работы в сервисе. */
export interface ThinkResult {
  text: string;
  usedFallback: boolean;
  startedAt: string;
}

/**
 * Состояние одного агента в одном процессе: задачи, одобрения,
 * открытые сессии браузера. Всё, что должно пережить рестарт, — в Store.
 */
export class AgentRuntime {
  readonly store: Store;
  readonly openRouter: OpenRouterClient;
  readonly hermes: HermesClient;
  readonly controlPlane: ControlPlaneClient;
  readonly skyvern: SkyvernClient | null;
  readonly approvals: Approvals;
  readonly handoffs: Handoffs;
  readonly browser: BrowserControl;
  readonly services: ServiceCatalog;
  readonly research: Research;
  /** Фактические списания OpenRouter, которые прокси увидел за ход Hermes. */
  readonly llmCosts = new LlmCostLedger();
  model: string;
  autonomous: boolean;
  /** Abort текущих ходов Hermes по id задачи. */
  private readonly aborts = new Map<string, AbortController>();
  /** Последний собранный /state. Пока новый сбор идёт, карточка получает его, а не таймаут. */
  private stateSnapshot: { at: number; state: RuntimeState } | null = null;
  private stateJob: Promise<RuntimeState> | null = null;

  constructor(readonly cfg: RuntimeConfig) {
    this.store = new Store(cfg.dataDir);
    this.model = cfg.model;
    this.autonomous = cfg.autonomous;
    this.openRouter = new OpenRouterClient(cfg.openRouterApiKey, cfg.model, fetch, { fallbackModels: [cfg.fallbackModel] });
    this.hermes = new HermesClient({
      apiUrl: cfg.hermesApiUrl,
      apiKey: cfg.hermesApiKey,
      fallback: this.openRouter,
      costs: this.llmCosts,
    });
    this.controlPlane = new ControlPlaneClient(cfg.controlPlaneUrl, cfg.agentId, cfg.runtimeToken);
    this.skyvern = cfg.skyvernApiKey ? new SkyvernClient(cfg.skyvernApiKey, this.store, cfg.email) : null;
    this.skyvern?.setMailboxReleaseHook(() => {
      void resumeDeferredMail(this);
    });
    this.approvals = new Approvals(this);
    this.handoffs = new Handoffs(this);
    this.browser = new BrowserControl(this);
    this.services = new ServiceCatalog(this);
    this.research = new Research(this);
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.handoffs.restore();
    const settings = await this.store.readSettings();
    if (settings.model) this.model = settings.model;
    if (settings.autonomous !== undefined) this.autonomous = settings.autonomous;
    const stale = (await this.store.listRuns()).filter((r) => r.status === "running" || r.status === "queued");
    for (const r of stale) {
      await this.finishRun(r, "failed", "Процесс перезапустился во время задачи");
    }
  }

  /** Сессия Skyvern или свой браузер заняты: машину не усыплять и не перезапускать. */
  get busyInBrowser(): boolean {
    if (this.skyvern?.busy) return true;
    return this.browser.waitingForCode;
  }

  // Runs

  async createRun(
    trigger: Run["trigger"],
    title: string,
    threadId: string | null,
    status: Run["status"] = "running",
  ): Promise<Run> {
    const run: Run = {
      id: newId("run"),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status,
      trigger,
      title: title.slice(0, 120),
      summary: "",
      threadId,
    };
    await this.store.saveRun(run);
    this.armAbort(run.id);
    log("run", status === "queued" ? "в очереди" : "начата", { id: run.id, trigger, title: run.title });
    return run;
  }

  async step(runId: string, kind: RunStep["kind"], text: string, data?: Record<string, unknown>): Promise<void> {
    const step: RunStep = { at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) };
    await this.store.addStep(runId, step);
  }

  async finishRun(run: Run, status: Run["status"], summary: string): Promise<void> {
    const current = (await this.store.getRun(run.id)) ?? run;
    // Отмена пользователем не должна быть перезаписана поздним finish из фоновой задачи.
    if (current.status === "canceled" && status !== "canceled") return;
    if (current.status === "failed" && status !== "failed") return;
    run.status = status;
    run.summary = redactInternal(summary).slice(0, 2000);
    run.finishedAt = status === "waiting_approval" ? null : new Date().toISOString();
    await this.store.saveRun(run);
    if (status !== "running" && status !== "queued" && status !== "waiting_approval") {
      this.disarmAbort(run.id);
    }
    log("run", "завершена", { id: run.id, status });
  }

  /** Задача ещё отменяема: идёт, в очереди или ждёт человека (одобрение либо «нужен человек»). */
  canCancel(run: Run): boolean {
    return run.status === "running" || run.status === "queued" || run.status === "waiting_approval" || run.status === "escalated";
  }

  /** Оборвать ход модели. Поздний finish не переписывает уже закрытую ошибкой задачу. */
  abortRun(runId: string): void {
    this.aborts.get(runId)?.abort();
  }

  async isCanceled(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    return run?.status === "canceled";
  }

  /**
   * Остановить задачу: оборвать Hermes, закрыть браузер, снять ожидания одобрения.
   * Фоновые await после этого увидят cancel и не перезапишут итог.
   */
  async cancelRun(runId: string): Promise<Run | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    if (!this.canCancel(run)) return run;

    this.aborts.get(runId)?.abort();
    this.skyvern?.cancelForRun(runId);
    try {
      await this.browser.closeForRun(runId);
    } catch (e) {
      warn("run", "браузер задачи не закрылся при остановке", { id: runId, error: String(e) });
    }

    const approvals = await this.store.listApprovals();
    const keep = approvals.filter((p) => p.runId !== runId);
    const dropped = approvals.filter((p) => p.runId === runId);
    if (dropped.length) {
      await this.store.saveApprovals(keep);
      for (const p of dropped) {
        if (p.kind === "handoff") await this.handoffs.drop(p.id);
      }
    }

    await this.step(runId, "note", "остановлено пользователем");
    await this.finishRun(run, "canceled", "Остановлено пользователем");
    await this.addChat({
      role: "agent",
      text: "Задача остановлена.",
      runId: run.id,
      chatId: await this.chatIdForRun(run),
    });
    log("run", "отменена пользователем", { id: run.id });
    return run;
  }

  signalFor(runId: string): AbortSignal | undefined {
    return this.aborts.get(runId)?.signal;
  }

  private armAbort(runId: string): AbortController {
    this.aborts.get(runId)?.abort();
    const c = new AbortController();
    this.aborts.set(runId, c);
    return c;
  }

  private disarmAbort(runId: string): void {
    this.aborts.delete(runId);
  }

  taskRef(run: Run): TaskRef {
    return { taskId: run.id, taskTitle: run.title };
  }

  /** Одна «мысль» Hermes в контексте задачи. Hermes сам ходит в MCP и скиллы. */
  async think(run: Run, prompt: string, action = "hermes.turn"): Promise<ThinkResult> {
    if (await this.isCanceled(run.id)) throw new DOMException("Задача остановлена", "AbortError");
    await ensureWorkGuides(this, run);
    const services = await this.store.readServices();
    const system = systemPrompt({
      agentName: this.cfg.agentName,
      email: this.cfg.email,
      ownerEmail: this.cfg.ownerEmail,
      autonomous: this.autonomous,
      runtimePort: this.cfg.port,
      services,
    });
    const withRun = ensureRunId(run.id, prompt);
    const startedAt = new Date().toISOString();
    await this.step(run.id, "model", "запрос модели", { chars: withRun.length });
    const signal = this.signalFor(run.id) ?? this.armAbort(run.id).signal;
    const r = await this.hermes.run(withRun, { sessionId: run.threadId ?? run.id, system, model: this.model, signal });
    if (await this.isCanceled(run.id)) throw new DOMException("Задача остановлена", "AbortError");
    const details = turnDetails(await this.store.listSteps(run.id), startedAt);
    await recordUsage(this.store, this.taskRef(run), action, "hermes", r, details);
    const text = redactInternal(r.text);
    await this.step(run.id, "model", text.slice(0, 4000), {
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd,
      usedFallback: r.usedFallback === true,
    });
    return { text, usedFallback: r.usedFallback === true, startedAt };
  }

  // Chat

  async addChat(msg: Omit<ChatMessage, "at" | "chatId"> & { chatId?: string | null }): Promise<void> {
    const chatId = msg.chatId || (await this.store.chats.ensureSystem()).id;
    const message: ChatMessage = { at: new Date().toISOString(), ...msg, chatId };
    await this.store.chats.addMessage(chatId, message);
    if (message.role !== "agent") return;
    const chat = await this.store.chats.get(chatId);
    if (!chat?.channel) return;
    await deliverChannelReply(this, chat.channel, message);
  }

  /** Чат, в котором владелец видит ход задачи: её собственный или «Почта и расписание». */
  async chatIdForRun(run: Run): Promise<string> {
    return run.trigger === "chat" && run.threadId ? run.threadId : (await this.store.chats.ensureSystem()).id;
  }

  /** Карточка сессии в чате: живой экран, пока открыта, после закрытия — видео. */
  async announceBrowser(run: Run, session: BrowserSession): Promise<void> {
    await this.addChat({
      role: "agent",
      kind: "browser",
      sessionId: session.id,
      text: `Работаю в браузере: ${session.purpose}`,
      runId: run.id,
      chatId: await this.chatIdForRun(run),
    });
  }

  // Settings / state

  async updateSettings(patch: { autonomous?: boolean | undefined; model?: string | undefined }): Promise<void> {
    const clean: { autonomous?: boolean; model?: string } = {};
    if (patch.autonomous !== undefined) {
      this.autonomous = patch.autonomous;
      clean.autonomous = patch.autonomous;
    }
    if (patch.model) {
      this.model = patch.model;
      clean.model = patch.model;
    }
    await this.store.writeSettings(clean);
  }

  async state(): Promise<RuntimeState> {
    const snap = this.stateSnapshot;
    const fresh = snap !== null && Date.now() - snap.at < 5_000;
    if (fresh) return snap.state;
    if (!this.stateJob) {
      const started = Date.now();
      this.stateJob = this.loadState()
        .then((state) => {
          this.stateSnapshot = { at: Date.now(), state };
          // #region agent log
          console.log(`[debug-105c57] state built ms=${Date.now() - started} runs=${state.runs.length}`);
          // #endregion
          return state;
        })
        .finally(() => {
          this.stateJob = null;
        });
    }
    if (snap) return snap.state;
    return this.stateJob;
  }

  private async loadState(): Promise<RuntimeState> {
    const [runs, chats, browserSessions, pendingApprovals, usage, connectedServices] = await Promise.all([
      this.store.listRuns(100),
      this.store.chats.list(),
      this.store.listBrowserSessions(),
      this.store.listApprovals(),
      this.store.usageSummary().catch(() => emptyUsage()),
      this.services.connected(),
    ]);
    return {
      agentId: this.cfg.agentId,
      email: this.cfg.email,
      model: this.model,
      autonomous: this.autonomous,
      busyInBrowser: this.busyInBrowser,
      pendingApprovals,
      runs,
      chats,
      browserSessions,
      usage,
      connectedServices,
    };
  }
}
