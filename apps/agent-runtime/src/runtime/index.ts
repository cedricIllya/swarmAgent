import type { BrowserSession, ChatMessage, Run, RunStep, RuntimeState } from "@swarm/contracts";
import { emptyUsage } from "@swarm/usage";
import { ControlPlaneClient } from "../control-plane";
import { HermesClient } from "../hermes";
import { OpenRouterClient } from "../openrouter";
import { Store } from "../store";
import { SkyvernClient } from "../browser/skyvern";
import { systemPrompt } from "../prompts";
import { redactInternal } from "../redact";
import { recordUsage, turnDetails, type TaskRef } from "../usage";
import type { RuntimeConfig } from "../config";
import { log } from "../log";
import { Approvals } from "./approvals";
import { BrowserControl } from "./browser";
import { newId } from "./ids";
import { Research } from "./research";
import { ServiceCatalog } from "./services";

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
  readonly browser: BrowserControl;
  readonly services: ServiceCatalog;
  readonly research: Research;
  model: string;
  autonomous: boolean;

  constructor(readonly cfg: RuntimeConfig) {
    this.store = new Store(cfg.dataDir);
    this.model = cfg.model;
    this.autonomous = cfg.autonomous;
    this.openRouter = new OpenRouterClient(cfg.openRouterApiKey, cfg.model);
    this.hermes = new HermesClient({ apiUrl: cfg.hermesApiUrl, apiKey: cfg.hermesApiKey, fallback: this.openRouter });
    this.controlPlane = new ControlPlaneClient(cfg.controlPlaneUrl, cfg.agentId, cfg.runtimeToken);
    this.skyvern = cfg.skyvernApiKey ? new SkyvernClient(cfg.skyvernApiKey, this.store, cfg.email) : null;
    this.approvals = new Approvals(this);
    this.browser = new BrowserControl(this);
    this.services = new ServiceCatalog(this);
    this.research = new Research(this);
  }

  async init(): Promise<void> {
    await this.store.init();
    const settings = await this.store.readSettings();
    if (settings.model) this.model = settings.model;
    if (settings.autonomous !== undefined) this.autonomous = settings.autonomous;
    const stale = (await this.store.listRuns()).filter((r) => r.status === "running" || r.status === "queued");
    for (const r of stale) {
      await this.finishRun(r, "failed", "Процесс перезапустился во время задачи");
    }
  }

  get busyInBrowser(): boolean {
    return this.browser.waitingForCode;
  }

  // Runs

  async createRun(trigger: Run["trigger"], title: string, threadId: string | null): Promise<Run> {
    const run: Run = {
      id: newId("run"),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      trigger,
      title: title.slice(0, 120),
      summary: "",
      threadId,
    };
    await this.store.saveRun(run);
    log("run", "начата", { id: run.id, trigger, title: run.title });
    return run;
  }

  async step(runId: string, kind: RunStep["kind"], text: string, data?: Record<string, unknown>): Promise<void> {
    const step: RunStep = { at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) };
    await this.store.addStep(runId, step);
  }

  async finishRun(run: Run, status: Run["status"], summary: string): Promise<void> {
    run.status = status;
    run.summary = redactInternal(summary).slice(0, 2000);
    run.finishedAt = status === "waiting_approval" ? null : new Date().toISOString();
    await this.store.saveRun(run);
    log("run", "завершена", { id: run.id, status });
  }

  taskRef(run: Run): TaskRef {
    return { taskId: run.id, taskTitle: run.title };
  }

  /** Одна «мысль» Hermes в контексте задачи. Hermes сам ходит в MCP и скиллы. */
  async think(run: Run, prompt: string, action = "hermes.turn"): Promise<string> {
    const services = await this.store.readServices();
    const system = systemPrompt({
      agentName: this.cfg.agentName,
      email: this.cfg.email,
      ownerEmail: this.cfg.ownerEmail,
      autonomous: this.autonomous,
      runtimePort: this.cfg.port,
      services,
    });
    const startedAt = new Date().toISOString();
    await this.step(run.id, "model", "запрос модели", { chars: prompt.length });
    const r = await this.hermes.run(prompt, { sessionId: run.threadId ?? run.id, system, model: this.model });
    const details = turnDetails(await this.store.listSteps(run.id), startedAt);
    await recordUsage(this.store, this.taskRef(run), action, "hermes", r, details);
    const text = redactInternal(r.text);
    await this.step(run.id, "model", text.slice(0, 4000), {
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd,
    });
    return text;
  }

  // Chat

  async addChat(msg: Omit<ChatMessage, "at" | "chatId"> & { chatId?: string | null }): Promise<void> {
    const chatId = msg.chatId || (await this.store.chats.ensureSystem()).id;
    await this.store.chats.addMessage(chatId, { at: new Date().toISOString(), ...msg, chatId });
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
