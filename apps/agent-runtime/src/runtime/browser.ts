import type { Run, ServiceCredential } from "@swarm/contracts";
import { browserFailure, chromeAvailable, chromeExecutable, ManagedBrowserSession, serviceProfileDir, type BrowserDeps } from "../browser/stagehand";
import { acceptInvite, type AcceptInviteResult } from "../browser/invite";
import { applyStorageToProfile } from "../browser/session-transfer";
import { OWNER_OUTAGE } from "../onboarding/connect";
import { hostOf, rootDomain } from "../onboarding/domains";
import { warn } from "../core/log";
import type { AgentRuntime } from "./index";

/**
 * Браузер агента. Онбординг сначала идёт в Skyvern: он обходит капчи.
 * Если Skyvern не настроен или не довёл вход — тот же цикл на своём Chromium.
 * Работа внутри сервиса без MCP и API — тоже свой Chromium. Сессии живут в этом
 * процессе: открыть, закрыть, передать код из письма. Записи шагов переживают рестарт.
 */
export class BrowserControl {
  readonly sessions = new Map<string, ManagedBrowserSession>();
  /** Открытие ещё не попало в sessions: второй запрос того же профиля иначе ждёт замок и падает. */
  private readonly opening = new Map<string, Promise<ManagedBrowserSession>>();

  constructor(private readonly rt: AgentRuntime) {}

  /** Свой Chromium найден на машине. */
  get available(): boolean {
    return chromeAvailable();
  }

  /** Онбординг: Skyvern или свой браузер. */
  get canOnboard(): boolean {
    return this.rt.skyvern !== null || this.available;
  }

  /** Свой браузер ждёт код. Почту в задачу Skyvern забирает захват ящика, не эта сессия. */
  get waitingForCode(): boolean {
    for (const s of this.sessions.values()) if (s.waitingForCode) return true;
    return false;
  }

  deps(): BrowserDeps {
    const { rt } = this;
    return { openRouter: rt.openRouter, model: rt.model, store: rt.store };
  }

  async open(run: Run, args: { purpose: string; serviceSlug: string | null; url?: string }): Promise<ManagedBrowserSession> {
    const { rt } = this;
    if (args.serviceSlug) {
      for (const open of this.sessions.values()) {
        if (open.serviceSlug !== args.serviceSlug) continue;
        const kept = await this.reuse(open, args.url);
        if (kept) return kept;
        break;
      }
      const pending = this.opening.get(args.serviceSlug);
      if (pending) {
        try {
          const kept = await this.reuse(await pending, args.url);
          if (kept) return kept;
        } catch (e) {
          warn("browser", "параллельное открытие сорвалось, запускаю заново", { error: String(e) });
        }
      }
    }
    const slug = args.serviceSlug;
    const job = this.launch(run, args);
    if (slug) this.opening.set(slug, job);
    try {
      return await job;
    } finally {
      if (slug && this.opening.get(slug) === job) this.opening.delete(slug);
    }
  }

  /** Живая сессия того же сервиса. Мёртвый Chromium закрываем, чтобы следующий запуск взял профиль. */
  private async reuse(s: ManagedBrowserSession, url?: string): Promise<ManagedBrowserSession | null> {
    if (!(await s.ready())) {
      warn("browser", "сессия не отвечает, закрываю", { id: s.id });
      await this.close(s.id).catch(() => undefined);
      return null;
    }
    if (!url) return s;
    try {
      await s.goto(url);
      return s;
    } catch (e) {
      if (browserFailure(e) !== "relaunch") {
        const message = e instanceof Error ? e.message : String(e);
        await this.rt.step(s.meta.runId, "error", `страница не открылась: ${message.slice(0, 180)}`).catch(() => undefined);
        throw e;
      }
      warn("browser", "сессия умерла на переходе, закрываю", { id: s.id, error: String(e) });
      await this.close(s.id).catch(() => undefined);
      return null;
    }
  }

  private launch(run: Run, args: { purpose: string; serviceSlug: string | null; url?: string }): Promise<ManagedBrowserSession> {
    const { rt } = this;
    return (async () => {
      let last: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const s = await ManagedBrowserSession.open(this.deps(), rt.taskRef(run), { runId: run.id, ...args });
          this.sessions.set(s.id, s);
          await rt.step(run.id, "browser", `открыт браузер: ${args.purpose}`, { sessionId: s.id });
          await rt.announceBrowser(run, s.meta);
          return s;
        } catch (e) {
          last = e;
          if (attempt === 2 || browserFailure(e) !== "relaunch") break;
          warn("browser", "повтор запуска браузера", { attempt, error: String(e) });
        }
      }
      const message = last instanceof Error ? last.message : String(last);
      await rt.step(run.id, "error", `браузер не открылся: ${message.slice(0, 180)}`).catch(() => undefined);
      throw last;
    })();
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const meta = await s.close();
    await this.rt.step(meta.runId, "browser", "браузер закрыт", { sessionId });
  }

  /** Закрыть свой браузер сервиса, прежде чем стереть его профиль. */
  async closeForService(slug: string): Promise<void> {
    const ids = [...this.sessions.entries()].filter(([, s]) => s.serviceSlug === slug).map(([id]) => id);
    for (const id of ids) await this.close(id);
  }

  /** Закрыть все свои сессии, привязанные к задаче (остановка пользователем). */
  async closeForRun(runId: string): Promise<void> {
    const ids = [...this.sessions.entries()].filter(([, s]) => s.meta.runId === runId).map(([id]) => id);
    for (const id of ids) await this.close(id);
  }

  /**
   * Код или ссылка — в ждущую сессию своего браузера. Задаче Skyvern письмо отдаёт inbox
   * целиком, без разбора кода и без ввода в страницу. Если сессия открыта, но ещё не ждёт,
   * код придерживается для ближайшего `wait-code`.
   */
  async deliverCode(v: { kind: "code" | "link"; value: string }): Promise<boolean> {
    for (const s of this.sessions.values()) {
      if (s.waitingForCode && s.deliverCode(v)) {
        await this.noteChallenge(v);
        return true;
      }
    }
    const latest = [...this.sessions.values()].at(-1);
    if (!latest) return false;
    latest.stashCode(v);
    await this.noteChallenge(v);
    return true;
  }

  /** В журнал задачи своего браузера. В страницу Skyvern код отсюда не попадает. */
  private async noteChallenge(v: { kind: "code" | "link"; value: string }): Promise<void> {
    const runId = this.activeRunId();
    if (!runId) return;
    const text = v.kind === "code" ? `код подтверждения из письма: ${v.value}` : `ссылка для входа из письма: ${v.value}`;
    await this.rt.step(runId, "email", text).catch((e) => warn("browser", "не записал код в журнал", { error: String(e) }));
  }

  /** Задача своего браузера, в журнал которой пишется код из письма. */
  activeRunId(): string | null {
    for (const s of this.sessions.values()) {
      if (s.waitingForCode) return s.meta.runId;
    }
    return [...this.sessions.values()].at(-1)?.meta.runId ?? null;
  }

  /**
   * Принять приглашение и зарегистрироваться под почтой агента. Skyvern — первый: runtime
   * отдаёт ему коды из писем и он обходит капчи. Если Skyvern не настроен или не справился,
   * та же задача идёт в своём Chromium; cookies остаются в профиле сервиса.
   * После входа записываем доступ (`type=credential`: почта, имя, пароль), а если рецепта
   * ещё нет — минимальный браузерный.
   */
  async acceptInvite(
    run: Run,
    args: { url: string; slug: string; service: string },
    opts?: { persist?: boolean; password?: string | null; skipSkyvern?: boolean; existing?: boolean },
  ): Promise<AcceptInviteResult> {
    const { rt } = this;
    const snap = await rt.store.readServices();
    const found = snap?.credentials.find((c) => c.slug === args.slug) ?? null;
    const existing: ServiceCredential | null = opts?.password ? { ...(found ?? { slug: args.slug, kind: "browser" }), password: opts.password } : found;
    const accountKnown = opts?.existing ?? Boolean(found?.password);

    let result: AcceptInviteResult | null = null;
    if (rt.skyvern && !opts?.skipSkyvern) {
      const skyvern = rt.skyvern;
      let sessionId: string | null = null;
      try {
        const opened = await skyvern.openBrowserSession();
        sessionId = opened.browserSessionId;
        const r = await skyvern.acceptInvite({
          runId: run.id,
          url: args.url,
          service: args.service,
          agentName: rt.cfg.agentName,
          firstName: rt.cfg.agentFirstName,
          lastName: rt.cfg.agentLastName,
          email: rt.cfg.email,
          password: existing?.password ?? null,
          existing: accountKnown,
          browserSessionId: opened.browserSessionId,
          onSession: (s) => rt.announceBrowser(run, s),
          onStep: (text, data) => rt.step(run.id, "browser", text, data),
        });
        const { session: _session, ...rest } = r;
        result = rest;
        if (result.status === "accepted" && chromeAvailable()) {
          try {
            const state = await skyvern.exportStorageState(opened.browserSessionId);
            await applyStorageToProfile({
              profileDir: serviceProfileDir(rt.store, args.slug),
              state,
              executablePath: chromeExecutable(),
            });
            result.cookiesInProfile = true;
            await rt.step(run.id, "note", `cookies Skyvern перенесены в профиль ${args.slug}`);
          } catch (e) {
            warn("browser", "перенос cookies Skyvern не удался", { error: String(e) });
            await rt.step(run.id, "note", `cookies Skyvern не перенесены: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (result.status !== "needs_human" && sessionId) {
          await skyvern.closeBrowserSession(sessionId);
          sessionId = null;
        }
      } catch (e) {
        if (sessionId) await skyvern.closeBrowserSession(sessionId).catch(() => undefined);
        warn("browser", "Skyvern не принял приглашение", { error: String(e) });
        result = {
          status: "failed",
          accountEmail: rt.cfg.email,
          password: null,
          steps: 0,
          finalUrl: "",
          notes: OWNER_OUTAGE,
          provider: "skyvern",
        };
      }
      // Истёкшая ссылка своим браузером не лечится. Остальной сбой Skyvern — повтор у себя.
      if (result.status === "failed" && result.barrierKind !== "invite_spent") {
        await rt.step(run.id, "note", "Повторяю вход своим браузером.");
        result = await this.acceptInviteWithStagehand(run, args, existing, accountKnown);
      }
    } else {
      result = await this.acceptInviteWithStagehand(run, args, existing, accountKnown);
    }

    if (result.status !== "accepted") {
      await rt.step(run.id, "note", `приглашение в ${args.service} не принято: ${result.notes}`);
      return result;
    }

    if (opts?.persist === false) return result;

    const recipeKnown = snap?.recipes.some((r) => r.slug === args.slug) ?? false;
    if (!recipeKnown) {
      let appUrl = result.finalUrl;
      try {
        appUrl = new URL(result.finalUrl || args.url).origin + "/";
      } catch {
        appUrl = args.url;
      }
      await rt.services.applyReport({
        type: "recipe",
        runId: run.id,
        recipe: {
          slug: args.slug,
          name: args.service,
          kind: "browser",
          domains: [rootDomain(hostOf(args.url))],
          browser: { loginUrl: args.url, appUrl },
          notes: "Вход по приглашению в браузере; MCP и API не искали или не нашли.",
          discoveredBy: rt.cfg.agentId,
        },
      });
    }

    const storageState =
      result.provider === "local" || result.cookiesInProfile
        ? { provider: "local" as const, profile: args.slug }
        : existing?.storageState;
    const credential: ServiceCredential = {
      ...(existing ?? {}),
      slug: args.slug,
      kind: existing?.kind ?? "browser",
      accountEmail: result.accountEmail,
      accountName: rt.cfg.agentName,
      ...(result.password ? { password: result.password } : {}),
      ...(storageState !== undefined ? { storageState } : {}),
    };
    await rt.services.applyReport({ type: "credential", runId: run.id, credential });
    await rt.step(run.id, "note", `аккаунт ${result.accountEmail} в ${args.service} сохранён${result.password ? ", пароль в журнале задачи" : ""}`);
    return result;
  }

  private async acceptInviteWithStagehand(
    run: Run,
    args: { url: string; slug: string; service: string },
    existing: ServiceCredential | null,
    accountKnown: boolean,
  ): Promise<AcceptInviteResult> {
    const { rt } = this;
    const session = await this.open(run, { purpose: `принять приглашение в ${args.service}`, serviceSlug: args.slug });
    let result: AcceptInviteResult;
    try {
      result = await acceptInvite(session, {
        url: args.url,
        service: args.service,
        agentName: rt.cfg.agentName,
        firstName: rt.cfg.agentFirstName,
        lastName: rt.cfg.agentLastName,
        email: rt.cfg.email,
        password: existing?.password ?? null,
        existing: accountKnown,
        onStep: (text, data) => rt.step(run.id, "browser", text, data),
      });
    } catch (e) {
      await session.shot();
      await this.close(session.id);
      throw e;
    }
    await session.shot();
    result.browserSessionId = session.id;
    result.liveUrl = /^https?:\/\//i.test(result.finalUrl) ? result.finalUrl : null;
    result.provider = "local";
    await this.close(session.id);
    return result;
  }
}
