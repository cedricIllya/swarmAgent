import Browserbase from "@browserbasehq/sdk";
import {
  mergeCredential,
  type BrowserSession,
  type ChatMessage,
  type PendingApproval,
  type Run,
  type RunStep,
  type RuntimeReport,
  type RuntimeState,
} from "@swarm/contracts";
import { emitRuntime } from "./events";
import { emptyUsage } from "@swarm/usage";
import { ControlPlaneClient } from "./control-plane";
import { HermesClient } from "./hermes";
import { OpenRouterClient, type WebCitation } from "./openrouter";
import { Store } from "./store";
import { ManagedBrowserSession, ensureContext, type BrowserDeps } from "./browser/stagehand";
import { SkyvernClient } from "./browser/skyvern";
import { acceptInvite, type AcceptInviteResult } from "./browser/invite";
import { approvalContinuationPrompt, systemPrompt } from "./prompts";
import { redactInternal } from "./redact";
import { recordUsage, turnDetails, type TaskRef } from "./usage";
import { discoverService, fetchPage, type DiscoveryInput, type DiscoveryResult, type FetchedPage } from "./discovery";
import { hostOf, matchRecipe, rootDomain } from "./domains";
import { syncHermesMcp } from "./hermes-config-sync";
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

  // Approvals

  async requestApproval(runId: string, description: string): Promise<{ approved: boolean; pending: PendingApproval | null }> {
    const safe = redactInternal(description);
    if (this.autonomous) {
      await this.step(runId, "note", `автономно: ${safe}`);
      return { approved: true, pending: null };
    }
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("run не найден");

    const chatId = await this.chatIdForRun(run);
    const pending: PendingApproval = {
      id: newId("apr"),
      runId,
      createdAt: new Date().toISOString(),
      description: safe,
      emailMessageId: null,
      chatId,
    };

    if (this.cfg.ownerEmail && this.controlPlane.enabled) {
      try {
        const { messageId } = await this.controlPlane.sendEmail({
          to: this.cfg.ownerEmail,
          subject: `Нужно одобрение: ${run.title}`,
          text: `${this.cfg.agentName} хочет:\n\n${safe}\n\nОтветьте «да» или «нет» одним словом. Любой другой текст станет новой задачей.`,
          ...(run.threadId ? { inReplyTo: run.threadId, references: [run.threadId] } : {}),
        });
        pending.emailMessageId = messageId;
        await this.store.rememberSent(messageId, { runId, to: this.cfg.ownerEmail, approvalId: pending.id });
        await this.step(runId, "email", `письмо с вопросом владельцу`, { messageId });
      } catch (e) {
        warn("approval", "не удалось отправить письмо", { error: String(e) });
      }
    }

    await this.addChat({
      role: "agent",
      text: `Нужно одобрение: ${safe}\nОтветьте «да» или «нет».`,
      runId,
      chatId,
    });
    const list = await this.store.listApprovals();
    list.push(pending);
    await this.store.saveApprovals(list);
    await this.finishRun(run, "waiting_approval", `Ждёт одобрения: ${safe}`);
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
    const chatId = pending.chatId ?? (await this.store.ensureSystemChat()).id;
    await this.addChat({ role: "agent", text, runId: run.id, chatId });
    return run;
  }

  /** Самое старое ожидание в ветке письма — то, на которое отвечают «да». */
  async approvalForThread(threadMessageId: string): Promise<PendingApproval | null> {
    const list = await this.store.listApprovals();
    return list.find((p) => p.emailMessageId === threadMessageId) ?? null;
  }

  // Chat

  async addChat(msg: Omit<ChatMessage, "at" | "chatId"> & { chatId?: string | null }): Promise<void> {
    const chatId = msg.chatId || (await this.store.ensureSystemChat()).id;
    await this.store.addChatMessage(chatId, { at: new Date().toISOString(), ...msg, chatId });
  }

  /** Чат, в котором владелец видит ход задачи: её собственный или «Почта и расписание». */
  async chatIdForRun(run: Run): Promise<string> {
    return run.trigger === "chat" && run.threadId ? run.threadId : (await this.store.ensureSystemChat()).id;
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
    await this.step(run.id, "browser", `открыт браузер: ${args.purpose}`, { sessionId: s.id, liveUrl: s.meta.liveUrl });
    await this.announceBrowser(run, s.meta);
    return s;
  }

  async closeBrowser(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const meta = await s.close();
    await this.step(meta.runId, "browser", "браузер закрыт", { sessionId, hasVideo: meta.hasVideo });
  }

  /**
   * Код или ссылка из письма — в ту сессию, которая ждёт. Если никто не ждёт, но сессия
   * открыта, код придерживается для её ближайшего `wait-code`: письмо часто приходит
   * раньше, чем страница с полем для кода успевает загрузиться.
   */
  deliverCodeToBrowser(v: { kind: "code" | "link"; value: string }): boolean {
    for (const s of this.sessions.values()) {
      if (s.waitingForCode && s.deliverCode(v)) return true;
    }
    const latest = [...this.sessions.values()].at(-1);
    if (!latest) return false;
    latest.stashCode(v);
    return true;
  }

  get browserAvailable(): boolean {
    return this.bb !== null;
  }

  /**
   * Принять приглашение и зарегистрироваться под почтой агента. Сессия идёт в постоянном
   * контексте сервиса, поэтому cookies останутся для следующих заходов. После входа
   * записываем доступ (`type=credential`), а если рецепта ещё нет — минимальный браузерный.
   */
  async acceptInvite(run: Run, args: { url: string; slug: string; service: string }): Promise<AcceptInviteResult> {
    const snap = await this.store.readServices();
    const existing = snap?.credentials.find((c) => c.slug === args.slug) ?? null;
    const session = await this.openBrowser(run, { purpose: `принять приглашение в ${args.service}`, serviceSlug: args.slug });
    let result: AcceptInviteResult;
    try {
      result = await acceptInvite(session, {
        url: args.url,
        service: args.service,
        agentName: this.cfg.agentName,
        email: this.cfg.email,
        password: existing?.password ?? null,
        onStep: (text, data) => this.step(run.id, "browser", text, data),
      });
    } finally {
      await this.closeBrowser(session.id);
    }

    if (result.status !== "accepted") {
      await this.step(run.id, "note", `приглашение в ${args.service} не принято: ${result.notes}`);
      return result;
    }

    const recipeKnown = snap?.recipes.some((r) => r.slug === args.slug) ?? false;
    if (!recipeKnown) {
      let appUrl = result.finalUrl;
      try {
        appUrl = new URL(result.finalUrl || args.url).origin + "/";
      } catch {
        appUrl = args.url;
      }
      await this.applyReport({
        type: "recipe",
        runId: run.id,
        recipe: {
          slug: args.slug,
          name: args.service,
          kind: "browser",
          domains: [rootDomain(hostOf(args.url))],
          browser: { loginUrl: args.url, appUrl },
          notes: "Вход по приглашению в браузере; MCP и API не искали или не нашли.",
          discoveredBy: this.cfg.agentId,
        },
      });
    }
    const contextId = await ensureContext(this.browserDeps(), args.slug);
    await this.applyReport({
      type: "credential",
      runId: run.id,
      credential: {
        ...(existing ?? {}),
        slug: args.slug,
        kind: existing?.kind ?? "browser",
        accountEmail: result.accountEmail,
        accountName: this.cfg.agentName,
        ...(result.password ? { password: result.password } : {}),
        storageState: { provider: "browserbase", contextId },
      },
    });
    return result;
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
    return snap.recipes
      .filter((r) => snap.credentials.some((c) => c.slug === r.slug))
      .map((r) => {
        const cred = snap.credentials.find((c) => c.slug === r.slug);
        return {
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          hasCredential: true,
          accountEmail: cred?.accountEmail ?? null,
          accountName: cred?.accountName ?? null,
          hasPassword: Boolean(cred?.password),
        };
      });
  }

  async publishServices(): Promise<void> {
    emitRuntime({ type: "services", connectedServices: await this.connectedServices() });
  }

  /** Переписать `mcp_servers` Hermes по текущему `services.json` и обновить карточку. */
  async refreshHermesMcp(): Promise<void> {
    const snap = await this.store.readServices();
    if (!snap) return;
    await syncHermesMcp(this.cfg.dataDir, snap, Boolean(this.cfg.skyvernApiKey));
    await this.publishServices();
  }

  /**
   * Новый рецепт или секрет: на control plane, в локальный `services.json`,
   * в `config.yaml` Hermes и строкой в журнал задачи.
   */
  async applyReport(input: RuntimeReport): Promise<{ slug: string; name: string; kind: "mcp" | "api" | "browser" }> {
    const prev =
      input.type === "credential"
        ? (await this.store.readServices())?.credentials.find((c) => c.slug === input.credential.slug)
        : undefined;
    const body = input.type === "credential" ? { ...input, credential: mergeCredential(prev, input.credential) } : input;
    await this.controlPlane.report(body);
    const snap = await this.store.readServices();
    const reported =
      body.type === "recipe"
        ? { name: body.recipe.name, kind: body.recipe.kind, slug: body.recipe.slug }
        : { name: body.credential.slug, kind: body.credential.kind, slug: body.credential.slug };
    if (snap) {
      if (body.type === "recipe") {
        snap.recipes = [...snap.recipes.filter((r) => r.slug !== body.recipe.slug), body.recipe];
      } else {
        snap.credentials = [...snap.credentials.filter((r) => r.slug !== body.credential.slug), body.credential];
      }
      await this.store.writeServices(snap);
      await this.refreshHermesMcp();
    }
    const kindLabel = { mcp: "MCP", api: "API", browser: "браузер" } as const;
    const running = body.runId
      ? await this.store.getRun(body.runId)
      : (await this.store.listRuns(20)).find((r) => r.status === "running");
    if (running) {
      const what = body.type === "recipe" ? "найден способ входа в" : "подключён сервис";
      await this.step(running.id, "note", `${what} ${reported.name} (${kindLabel[reported.kind]})`);
    }
    return reported;
  }

  // Discovery

  /** Рецепт из каталога по доменам ссылок и подсказке классификатора. */
  async knownRecipe(hosts: string[]): Promise<ReturnType<typeof matchRecipe>> {
    const services = await this.store.readServices();
    return services ? matchRecipe(services.recipes, hosts.filter(Boolean)) : null;
  }

  /**
   * Сервиса нет в каталоге: ищем MCP в реестре и на домене, документацию в интернете,
   * проверяем найденный MCP. Подтверждённый MCP сразу записываем рецептом — Hermes
   * получит инструменты `mcp_<slug>_*` ещё до первого хода модели.
   */
  async discover(run: Run, input: DiscoveryInput): Promise<DiscoveryResult> {
    const result = await discoverService(input, {
      openRouter: this.openRouter,
      model: this.model,
      agentId: this.cfg.agentId,
      onStep: (text, data) => this.step(run.id, "tool", text, data),
      onUsage: (action, r) => recordUsage(this.store, this.taskRef(run), action, "runtime", r),
    });
    if (result.confirmed && result.draftRecipe) {
      const snap = await this.store.readServices();
      const taken = snap?.recipes.find((r) => r.slug === result.slug);
      if (!taken) {
        await this.applyReport({ type: "recipe", recipe: result.draftRecipe, runId: run.id });
      } else {
        await this.step(run.id, "note", `слаг ${result.slug} уже занят рецептом «${taken.name}», рецепт не записан`);
      }
    }
    return result;
  }

  /** Один поиск в интернете с цитатами: для документации и вопросов «найди в интернете». */
  async webSearch(query: string, task: TaskRef, maxResults = 6): Promise<{ answer: string; results: WebCitation[] }> {
    const r = await this.openRouter.chat(
      [
        {
          role: "user",
          content: `Найди в интернете и кратко ответь со ссылками на источники:\n${query.slice(0, 2000)}`,
        },
      ],
      { temperature: 0, maxTokens: 900, webSearch: { maxResults } },
      this.model,
    );
    await recordUsage(this.store, task, "web.search", "runtime", r);
    return { answer: r.text, results: r.citations };
  }

  /** Страница документации текстом без разметки, чтобы агент читал её одним вызовом. */
  async readDocs(url: string, maxChars = 20_000): Promise<FetchedPage | null> {
    return fetchPage(url, fetch, maxChars);
  }

  async state(): Promise<RuntimeState> {
    const [runs, chats, browserSessions, pendingApprovals, usage, connectedServices] = await Promise.all([
      this.store.listRuns(100),
      this.store.listChats(),
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
      chats,
      browserSessions,
      usage,
      connectedServices,
    };
  }
}
