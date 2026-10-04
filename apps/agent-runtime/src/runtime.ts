import Browserbase from "@browserbasehq/sdk";
import type { ChatMessage, PendingApproval, Run, RunStep, RuntimeState, ServiceRecipe } from "@swarm/contracts";
import { emptyUsage } from "@swarm/usage";
import { ControlPlaneClient } from "./control-plane";
import { HermesClient } from "./hermes";
import { OpenRouterClient } from "./openrouter";
import { Store } from "./store";
import { ManagedBrowserSession, type BrowserDeps } from "./browser/stagehand";
import { SkyvernClient } from "./browser/skyvern";
import { approvalContinuationPrompt, systemPrompt } from "./prompts";
import { recordUsage, type TaskRef } from "./usage";
import type { RuntimeConfig } from "./config";
import { log, warn } from "./log";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  private readonly bb: Browserbase | null;
  readonly sessions = new Map<string, ManagedBrowserSession>();
  model: string;
  autonomous: boolean;

  constructor(readonly cfg: RuntimeConfig) {
    this.store = new Store(cfg.dataDir);
    this.model = cfg.model;
    this.autonomous = cfg.autonomous;
    this.openRouter = new OpenRouterClient(cfg.openRouterApiKey, cfg.model);
    this.hermes = new HermesClient({ apiUrl: cfg.hermesApiUrl, apiKey: cfg.hermesApiKey, fallback: this.openRouter });
    this.controlPlane = new ControlPlaneClient(cfg.controlPlaneUrl, cfg.agentId, cfg.runtimeToken);
    this.bb = cfg.browserbase ? new Browserbase({ apiKey: cfg.browserbase.apiKey }) : null;
    this.skyvern = cfg.skyvernApiKey ? new SkyvernClient(cfg.skyvernApiKey, this.store) : null;
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
    for (const s of this.sessions.values()) if (s.waitingForCode) return true;
    return false;
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
    run.summary = summary.slice(0, 2000);
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
    await this.step(run.id, "model", "запрос модели", { chars: prompt.length });
    const r = await this.hermes.run(prompt, { sessionId: run.threadId ?? run.id, system, model: this.model });
    await recordUsage(this.store, this.taskRef(run), action, "hermes", r);
    await this.step(run.id, "model", r.text.slice(0, 4000), {
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      costUsd: r.costUsd,
    });
    return r.text;
  }

  // Approvals

  async requestApproval(runId: string, description: string): Promise<{ approved: boolean; pending: PendingApproval | null }> {
    if (this.autonomous) {
      await this.step(runId, "note", `автономно: ${description}`);
      return { approved: true, pending: null };
    }
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("run не найден");

    const pending: PendingApproval = {
      id: newId("apr"),
      runId,
      createdAt: new Date().toISOString(),
      description,
      emailMessageId: null,
    };

    if (this.cfg.ownerEmail && this.controlPlane.enabled) {
      try {
        const { messageId } = await this.controlPlane.sendEmail({
          to: this.cfg.ownerEmail,
          subject: `Нужно одобрение: ${run.title}`,
          text: `${this.cfg.agentName} хочет:\n\n${description}\n\nОтветьте «да» или «нет» одним словом. Любой другой текст станет новой задачей.`,
          ...(run.threadId ? { inReplyTo: run.threadId, references: [run.threadId] } : {}),
        });
        pending.emailMessageId = messageId;
        await this.store.rememberSent(messageId, { runId, to: this.cfg.ownerEmail, approvalId: pending.id });
        await this.step(runId, "email", `письмо с вопросом владельцу`, { messageId });
      } catch (e) {
        warn("approval", "не удалось отправить письмо", { error: String(e) });
      }
    }

    await this.addChat({ role: "agent", text: `Нужно одобрение: ${description}\nОтветьте «да» или «нет».`, runId });
    const list = await this.store.listApprovals();
    list.push(pending);
    await this.store.saveApprovals(list);
    await this.finishRun(run, "waiting_approval", `Ждёт одобрения: ${description}`);
    return { approved: false, pending };
  }

  async resolveApproval(approvalId: string, approved: boolean): Promise<Run | null> {
    const list = await this.store.listApprovals();
    const pending = list.find((p) => p.id === approvalId);
    if (!pending) return null;
    await this.store.saveApprovals(list.filter((p) => p.id !== approvalId));
    const run = await this.store.getRun(pending.runId);
    if (!run) return null;
    run.status = "running";
    await this.store.saveRun(run);
    await this.step(run.id, "note", approved ? "одобрено человеком" : "отклонено человеком");
    const text = await this.think(run, approvalContinuationPrompt(pending.description, approved), "hermes.approval");
    await this.finishRun(run, "done", text);
    await this.addChat({ role: "agent", text, runId: run.id });
    return run;
  }

  /** Самое старое ожидание в ветке письма — то, на которое отвечают «да». */
  async approvalForThread(threadMessageId: string): Promise<PendingApproval | null> {
    const list = await this.store.listApprovals();
    return list.find((p) => p.emailMessageId === threadMessageId) ?? null;
  }

  // Chat

  async addChat(msg: Omit<ChatMessage, "at">): Promise<void> {
    await this.store.addChat({ at: new Date().toISOString(), ...msg });
  }

  // Browser

  browserDeps(): BrowserDeps {
    if (!this.bb || !this.cfg.browserbase) throw new Error("Browserbase не настроен: BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID");
    return {
      bb: this.bb,
      projectId: this.cfg.browserbase.projectId,
      apiKey: this.cfg.browserbase.apiKey,
      openRouter: this.openRouter,
      model: this.model,
      store: this.store,
    };
  }

  async openBrowser(run: Run, args: { purpose: string; serviceSlug: string | null; url?: string }): Promise<ManagedBrowserSession> {
    const s = await ManagedBrowserSession.open(this.browserDeps(), this.taskRef(run), { runId: run.id, ...args });
    this.sessions.set(s.id, s);
    await this.step(run.id, "browser", `открыт браузер: ${args.purpose}`, { sessionId: s.id });
    return s;
  }

  async closeBrowser(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const meta = await s.close();
    await this.step(meta.runId, "browser", "браузер закрыт", { sessionId, hasVideo: meta.hasVideo });
  }

  /** Код или ссылка из письма — в ту сессию, которая ждёт. */
  deliverCodeToBrowser(v: { kind: "code" | "link"; value: string }): boolean {
    for (const s of this.sessions.values()) {
      if (s.waitingForCode && s.deliverCode(v)) return true;
    }
    return false;
  }

  // Settings / services

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

  async connectedServices(): Promise<RuntimeState["connectedServices"]> {
    const snap = await this.store.readServices();
    if (!snap) return [];
    return snap.recipes.map((r: ServiceRecipe) => ({
      slug: r.slug,
      name: r.name,
      kind: r.kind,
      hasCredential: snap.credentials.some((c) => c.slug === r.slug),
    }));
  }

  async state(): Promise<RuntimeState> {
    const [runs, chat, browserSessions, pendingApprovals, usage, connectedServices] = await Promise.all([
      this.store.listRuns(100),
      this.store.listChat(200),
      this.store.listBrowserSessions(),
      this.store.listApprovals(),
      this.store.usageSummary().catch(() => emptyUsage()),
      this.connectedServices(),
    ]);
    return {
      agentId: this.cfg.agentId,
      email: this.cfg.email,
      model: this.model,
      autonomous: this.autonomous,
      busyInBrowser: this.busyInBrowser,
      pendingApprovals,
      runs,
      chat,
      browserSessions,
      usage,
      connectedServices,
    };
  }
}
