import type { Run, ServiceCredential } from "@swarm/contracts";
import { chromeAvailable, ManagedBrowserSession, type BrowserDeps } from "../browser/stagehand";
import { acceptInvite, type AcceptInviteResult } from "../browser/invite";
import { OWNER_OUTAGE } from "../connect";
import { hostOf, rootDomain } from "../domains";
import { warn } from "../log";
import type { AgentRuntime } from "./index";

/**
 * Браузер агента. Онбординг сначала идёт в Skyvern: он обходит капчи.
 * Если Skyvern не настроен или не довёл вход — тот же цикл на своём Chromium.
 * Работа внутри сервиса без MCP и API — тоже свой Chromium. Сессии живут в этом
 * процессе: открыть, закрыть, передать код из письма. Записи шагов переживают рестарт.
 */
export class BrowserControl {
  readonly sessions = new Map<string, ManagedBrowserSession>();

  constructor(private readonly rt: AgentRuntime) {}

  /** Свой Chromium найден на машине. */
  get available(): boolean {
    return chromeAvailable();
  }

  /** Онбординг: Skyvern или свой браузер. */
  get canOnboard(): boolean {
    return this.rt.skyvern !== null || this.available;
  }

  /** Кто-то ждёт код из письма: почта идёт в него, а не в новую задачу. */
  get waitingForCode(): boolean {
    if (this.rt.skyvern?.busy) return true;
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
        if (args.url) await open.goto(args.url);
        return open;
      }
    }
    const s = await ManagedBrowserSession.open(this.deps(), rt.taskRef(run), { runId: run.id, ...args });
    this.sessions.set(s.id, s);
    await rt.step(run.id, "browser", `открыт браузер: ${args.purpose}`, { sessionId: s.id });
    await rt.announceBrowser(run, s.meta);
    return s;
  }

  async close(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    const meta = await s.close();
    await this.rt.step(meta.runId, "browser", "браузер закрыт", { sessionId });
  }

  /**
   * Код или ссылка из письма — туда, где её ждут. Задача Skyvern в приоритете: она не умеет
   * читать почту сама. Иначе — в ждущую сессию своего браузера. Если никто не ждёт, но сессия
   * открыта, код придерживается для её ближайшего `wait-code`: письмо часто приходит
   * раньше, чем страница с полем для кода успевает загрузиться.
   */
  deliverCode(v: { kind: "code" | "link"; value: string }): boolean {
    if (this.rt.skyvern?.busy) {
      this.rt.skyvern.pushCode(v).catch((e) => warn("browser", "код в Skyvern не ушёл", { error: String(e) }));
      return true;
    }
    for (const s of this.sessions.values()) {
      if (s.waitingForCode && s.deliverCode(v)) return true;
    }
    const latest = [...this.sessions.values()].at(-1);
    if (!latest) return false;
    latest.stashCode(v);
    return true;
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
    opts?: { persist?: boolean; password?: string | null; skipSkyvern?: boolean },
  ): Promise<AcceptInviteResult> {
    const { rt } = this;
    const snap = await rt.store.readServices();
    const found = snap?.credentials.find((c) => c.slug === args.slug) ?? null;
    const existing: ServiceCredential | null = opts?.password ? { ...(found ?? { slug: args.slug, kind: "browser" }), password: opts.password } : found;

    let result: AcceptInviteResult | null = null;
    if (rt.skyvern && !opts?.skipSkyvern) {
      try {
        const r = await rt.skyvern.acceptInvite({
          runId: run.id,
          url: args.url,
          service: args.service,
          agentName: rt.cfg.agentName,
          email: rt.cfg.email,
          password: existing?.password ?? null,
          onSession: (s) => rt.announceBrowser(run, s),
          onStep: (text, data) => rt.step(run.id, "browser", text, data),
        });
        const { session: _session, ...rest } = r;
        result = rest;
      } catch (e) {
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
        result = await this.acceptInviteWithStagehand(run, args, existing);
      }
    } else {
      result = await this.acceptInviteWithStagehand(run, args, existing);
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
      result.provider === "local" ? { provider: "local" as const, profile: args.slug } : existing?.storageState;
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
    await rt.step(run.id, "note", `аккаунт ${result.accountEmail} в ${args.service} сохранён${result.password ? ", пароль в карточке агента" : ""}`);
    return result;
  }

  private async acceptInviteWithStagehand(
    run: Run,
    args: { url: string; slug: string; service: string },
    existing: ServiceCredential | null,
  ): Promise<AcceptInviteResult> {
    const { rt } = this;
    const session = await this.open(run, { purpose: `принять приглашение в ${args.service}`, serviceSlug: args.slug });
    let result: AcceptInviteResult;
    try {
      result = await acceptInvite(session, {
        url: args.url,
        service: args.service,
        agentName: rt.cfg.agentName,
        email: rt.cfg.email,
        password: existing?.password ?? null,
        onStep: (text, data) => rt.step(run.id, "browser", text, data),
      });
    } catch (e) {
      await this.close(session.id);
      throw e;
    }
    result.liveUrl = null;
    result.browserSessionId = null;
    result.provider = "local";
    await this.close(session.id);
    return result;
  }
}
