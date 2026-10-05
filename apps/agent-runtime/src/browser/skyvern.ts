import type { BrowserSession } from "@swarm/contracts";
import type { Store } from "../store";
import { downloadUrlTo } from "./recordings";
import { blockerKind, looksLikeServiceApprovalWait } from "../connect";
import { generatePassword, type AcceptInviteResult } from "./invite";
import { exportStorageFromCdp, type BrowserStorageState } from "./session-transfer";
import { log, warn } from "../log";

/**
 * Skyvern — только онбординг: принять приглашение, зарегистрироваться, войти.
 * Задачи внутри сервиса — свой Chromium.
 *
 * Коды и magic link из писем Skyvern сам не получает: runtime принимает письмо на адрес
 * агента и отдаёт его в Skyvern через `POST /v1/credentials/totp` с `totp_identifier`
 * равным этому адресу. Задача запускается с тем же `totp_identifier`, поэтому код
 * попадает в нужный запуск.
 * https://docs.skyvern.com/credentials/totp
 */

const TERMINAL = new Set(["completed", "failed", "terminated", "canceled", "timed_out"]);

/**
 * Content для Skyvern TOTP: полное письмо предпочтительнее — сервис сам вытащит код.
 * Иначе — фраза с цифрами или сама ссылка.
 */
export function totpContent(v: { kind: "code" | "link"; value: string; emailBody?: string | undefined }): string {
  const body = v.emailBody?.trim();
  if (body && body.length > 10) return body.slice(0, 8000);
  if (v.kind === "code") return `Your verification code is ${v.value}`;
  return v.value;
}

export const INVITE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["landed", "accepted", "blocked", "captcha", "expired", "needs_human", "pending_approval", "failed"],
      description:
        "landed — внутри приложения, без форм входа; pending_approval — заявка на регистрацию ждёт администратора сервиса; blocked — барьер (SSO, оплата, телефон, капча после ожидания); expired — приглашение недействительно; failed — иначе",
    },
    blocker_kind: {
      type: "string",
      enum: ["captcha", "sso_only", "two_factor", "phone", "payment", "password_rejected", "email_rejected", "invite_spent", "pending_approval", "other"],
    },
    account_email: { type: "string" },
    password_set: { type: "boolean", description: "true, если на форме регистрации задали пароль из инструкции" },
    final_url: { type: "string" },
    notes: { type: "string", description: "что было на странице и на чём остановились, одно-два предложения" },
  },
} as const;

export const LOGIN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    logged_in: { type: "boolean" },
    account_email: { type: "string" },
    notes: { type: "string" },
  },
} as const;

export interface SkyvernInviteArgs {
  runId: string;
  url: string;
  service: string;
  agentName: string;
  email: string;
  /** Пароль, если у агента уже есть аккаунт в сервисе. Иначе придумаем свой. */
  password?: string | null;
  /** Аккаунт уже есть: только вход, без регистрации и смены пароля. По умолчанию — есть ли пароль. */
  existing?: boolean;
  /** Уже открытая сессия: регистрация и поиск ключа делят cookies. */
  browserSessionId?: string | null;
  maxSteps?: number;
  timeoutMs?: number;
  onSession?: (session: BrowserSession) => Promise<void>;
  onStep?: (text: string, data?: Record<string, unknown>) => Promise<void> | void;
}

export interface SkyvernLoginArgs {
  runId: string;
  url: string;
  purpose: "signup" | "login";
  prompt: string;
  credentials: Record<string, string>;
  timeoutMs?: number;
  onSession?: (session: BrowserSession) => Promise<void>;
}

interface ActiveRun {
  skyvernRunId: string;
  sessionId: string;
  runId: string;
  startedAt: number;
}

/** Текст задачи Skyvern: принять приглашение. Существующий аккаунт — только вход, без нового пароля. */
export function inviteTaskPrompt(args: {
  service: string;
  agentName: string;
  email: string;
  password: string;
  existing?: boolean;
}): string {
  const identity = [
    `Имя вводи сам, до кнопки отправки: в name, full name, first name, last name, display name и username — «${args.agentName}». Одно слово — и в имя, и в фамилию. Пустым имя не оставляй. Адрес электронной почты — только ${args.email}.`,
    "Способ входа — только почта (Continue with email). Google, Microsoft, GitHub, Apple и SSO не выбирай, если есть обычный путь.",
    "Если просят код из письма или magic link — жди: письмо придёт на этот адрес, код или ссылка появятся сами. Код не выдумывай.",
    "Капча решается сама. Подожди и продолжи. outcome=blocked и blocker_kind=captcha — только если после ожидания страница всё ещё не пускает.",
    "SSO без почты, аппаратный 2FA, телефон или оплата — outcome=blocked и blocker_kind (sso_only, two_factor, phone, payment). Не обходи.",
    "Не нажимай unsubscribe и help. Не меняй настройки, никого не приглашай, ничего не оплачивай.",
    "Страница «приглашение принято» без рабочего интерфейса — это ещё не конец. landed только когда видишь приложение: навигацию или список, и нет формы входа.",
    "Если сервис пишет, что заявка на регистрацию или вступление ждёт одобрения администратора — это не вход. outcome=pending_approval. Пароль, если уже задал, отметь password_set и больше ничего не нажимай.",
    "Подтверждение почты кодом или ссылкой — не pending_approval: жди письмо.",
  ];
  const mode = args.existing
    ? [
        `Войди в уже существующий аккаунт ${args.service} под ${args.email}. Новый аккаунт не регистрируй.`,
        "Если страница уже показывает рабочий интерфейс без формы входа — ничего не делай и сразу верни outcome=landed.",
        "Если продукт предлагает код на почту или magic link — предпочти его паролю.",
        `Иначе пароль ровно этот: ${args.password}.`,
        "Никогда не меняй пароль и не ходи по «forgot/reset password», даже если продукт предлагает и даже если такое письмо пришло.",
        "Если пароль отклонён и нет пути через код — outcome=blocked, blocker_kind=password_rejected.",
      ]
    : [
        `Прими приглашение в ${args.service} и зарегистрируй новый аккаунт под ${args.email}.`,
        `Пароль этого аккаунта: ${args.password}. Сам введи его в поле пароля и в подтверждение до отправки формы. Другой не выдумывай и поле не оставляй пустым.`,
        "Форму с пустым именем или паролем не отправляй.",
        "Сразу после регистрации сервис может показать обычную форму входа. Войди тем же адресом и тем же паролем. Второй аккаунт не создавай.",
        "«Забыли пароль» и смену пароля не открывай. Если регистрация говорит, что аккаунт с этим адресом уже есть — войди им же.",
      ];
  return [
    ...mode,
    "",
    "Правила:",
    ...identity.map((line) => `- ${line}`),
    "",
    "Закончи JSON: outcome=landed и final_url, когда ты внутри приложения. password_set — задавал ли ты пароль из инструкции.",
  ].join("\n");
}

/** Что Skyvern извлёк в конце задачи → итог шага 0 в терминах runtime. */
export function interpretInviteOutput(
  status: string,
  output: unknown,
  ctx: { email: string; password: string; failureReason?: string | null },
): AcceptInviteResult {
  const o = (output && typeof output === "object" ? output : {}) as {
    outcome?: string;
    account_email?: string;
    password_set?: boolean;
    final_url?: string;
    notes?: string;
  };
  const notes = typeof o.notes === "string" && o.notes.trim() ? o.notes.trim().slice(0, 400) : "";
  const finalUrl = typeof o.final_url === "string" ? o.final_url : "";
  const kind = blockerKind((o as { blocker_kind?: unknown }).blocker_kind);
  const base = {
    accountEmail: ctx.email,
    password: o.password_set ? ctx.password : null,
    steps: 0,
    finalUrl,
    provider: "skyvern" as const,
    barrierKind: kind,
  };
  const outcome = o.outcome ?? "";
  const pending =
    outcome === "pending_approval" ||
    kind === "pending_approval" ||
    ((outcome === "accepted" || outcome === "landed" || outcome === "blocked" || outcome === "") && looksLikeServiceApprovalWait(notes));
  if (pending) {
    return {
      ...base,
      status: "needs_human",
      barrierKind: "pending_approval",
      notes: notes || "заявка на регистрацию ждёт одобрения в сервисе",
    };
  }
  if (status === "completed" && (outcome === "accepted" || outcome === "landed" || outcome === "")) {
    return { ...base, status: "accepted", notes: notes || (outcome ? `вход выполнен, аккаунт ${ctx.email}` : "пустой outcome, считаем что вошли") };
  }
  if (outcome === "captcha" || outcome === "blocked" || outcome === "needs_human" || status === "terminated") {
    const barrier = kind ?? (outcome === "captcha" ? "captcha" : "other");
    return { ...base, status: "needs_human", barrierKind: barrier, notes: notes || (outcome === "captcha" ? "капча" : "нужен человек") };
  }
  if (outcome === "expired") {
    return { ...base, status: "failed", barrierKind: "invite_spent", notes: notes || "приглашение недействительно" };
  }
  const reason = ctx.failureReason?.trim() || notes || `Skyvern завершил задачу со статусом ${status}`;
  return { ...base, status: "failed", notes: reason.slice(0, 400) };
}

export class SkyvernClient {
  private readonly active = new Map<string, ActiveRun>();
  /** Сессия жива до close или до таймаута: почта в это время удерживается. */
  private readonly held = new Map<string, number>();
  private readonly sessionLive = new Map<string, string | null>();
  /** CDP-адрес сессии для экспорта cookies в свой Chromium. */
  private readonly sessionCdp = new Map<string, string | null>();
  private readonly metas = new Map<string, BrowserSession>();
  /** Код пришёл между задачами одной сессии — отдадим в следующую. */
  private readonly pendingTotp: string[] = [];
  /** Задачи runtime, которые пользователь остановил — опрос Skyvern выходит сразу. */
  private readonly canceledRuns = new Set<string>();

  constructor(
    private readonly apiKey: string,
    private readonly store: Store,
    /** Почта агента: `totp_identifier` всех задач и ключ для передачи кодов. */
    private readonly totpIdentifier: string,
    private readonly base = "https://api.skyvern.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Идёт задача или открыта сессия онбординга: почта с кодом должна уйти в неё. */
  get busy(): boolean {
    const now = Date.now();
    for (const [id, until] of this.held) if (until <= now) this.held.delete(id);
    return this.active.size > 0 || this.held.size > 0;
  }

  /** Остановить задачи Skyvern и закрыть сессии, привязанные к runId. */
  cancelForRun(runId: string): void {
    this.canceledRuns.add(runId);
    for (const [skyvernRunId, run] of this.active) {
      if (run.runId !== runId) continue;
      void this.cancel(skyvernRunId);
    }
    for (const [metaId, meta] of [...this.metas.entries()]) {
      if (meta.runId !== runId || meta.finishedAt) continue;
      const browserSessionId = metaId.startsWith("skyvern-") ? metaId.slice("skyvern-".length) : null;
      if (browserSessionId && this.held.has(browserSessionId)) {
        void this.closeBrowserSession(browserSessionId);
      }
    }
  }

  /** runId задачи, в которую сейчас идёт браузер Skyvern (для журнала кода). */
  activeRunId(): string | null {
    const latest = [...this.active.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (latest) return latest.runId;
    // Сессия жива между задачами (поиск ключа): код всё равно пишем в её run.
    for (const meta of this.metas.values()) {
      if (!meta.finishedAt) return meta.runId;
    }
    return null;
  }

  /** Одна сессия на весь онбординг: captcha-solver и общие cookies. */
  async openBrowserSession(): Promise<{ browserSessionId: string; liveUrl: string | null; browserAddress: string | null }> {
    const res = await this.fetchImpl(`${this.base}/v1/browser_sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ timeout: 45, extensions: ["captcha-solver"] }),
    });
    if (!res.ok) throw new Error(`Skyvern session ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      browser_session_id?: string;
      app_url?: string | null;
      browser_address?: string | null;
    };
    if (!json.browser_session_id) throw new Error("Skyvern не вернул browser_session_id");
    // Страница сессии в Skyvern: живой экран и кнопка Take Control.
    const liveUrl = json.app_url ?? `https://app.skyvern.com/browser-session/${json.browser_session_id}`;
    this.held.set(json.browser_session_id, Date.now() + 45 * 60 * 1000);
    this.sessionLive.set(json.browser_session_id, liveUrl);
    let browserAddress = json.browser_address?.trim() || null;
    if (!browserAddress) browserAddress = await this.fetchBrowserAddress(json.browser_session_id);
    this.sessionCdp.set(json.browser_session_id, browserAddress);
    log("skyvern", "сессия открыта", {
      browserSessionId: json.browser_session_id,
      extensions: ["captcha-solver"],
      hasCdp: Boolean(browserAddress),
    });
    return { browserSessionId: json.browser_session_id, liveUrl, browserAddress };
  }

  /** CDP URL живой сессии (кэш или GET). */
  async browserAddress(browserSessionId: string): Promise<string | null> {
    if (this.sessionCdp.has(browserSessionId)) {
      const cached = this.sessionCdp.get(browserSessionId) ?? null;
      if (cached) return cached;
    }
    const addr = await this.fetchBrowserAddress(browserSessionId);
    this.sessionCdp.set(browserSessionId, addr);
    return addr;
  }

  /**
   * Cookies/localStorage живой сессии для засева в свой Chromium.
   * Сессию не закрывает — вызывающий закрывает после переноса.
   */
  async exportStorageState(browserSessionId: string): Promise<BrowserStorageState> {
    const cdpUrl = await this.browserAddress(browserSessionId);
    if (!cdpUrl) throw new Error("у сессии Skyvern нет browser_address");
    return exportStorageFromCdp({ cdpUrl, apiKey: this.apiKey });
  }

  private async fetchBrowserAddress(browserSessionId: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(`${this.base}/v1/browser_sessions/${browserSessionId}`, {
        headers: { "x-api-key": this.apiKey },
      });
      if (!res.ok) {
        warn("skyvern", "не удалось получить browser_address", { status: res.status });
        return null;
      }
      const json = (await res.json()) as { browser_address?: string | null };
      return json.browser_address?.trim() || null;
    } catch (e) {
      warn("skyvern", "не удалось получить browser_address", { error: String(e) });
      return null;
    }
  }

  /** Сессия ещё жива у нас (не закрыта и не вышла по таймауту). */
  sessionAlive(browserSessionId: string): boolean {
    const until = this.held.get(browserSessionId);
    return until !== undefined && until > Date.now();
  }

  async closeBrowserSession(browserSessionId: string): Promise<void> {
    this.held.delete(browserSessionId);
    this.sessionLive.delete(browserSessionId);
    this.sessionCdp.delete(browserSessionId);
    this.pendingTotp.length = 0;
    const meta = this.metas.get(`skyvern-${browserSessionId}`);
    this.metas.delete(`skyvern-${browserSessionId}`);
    if (meta) {
      meta.finishedAt = new Date().toISOString();
      meta.liveUrl = null;
      await this.store.saveBrowserSession(meta);
    }
    try {
      await this.fetchImpl(`${this.base}/v1/browser_sessions/${browserSessionId}/close`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
      });
    } catch (e) {
      warn("skyvern", "не удалось закрыть сессию", { error: String(e) });
    }
  }

  /**
   * Принять приглашение под почтой агента. Своя сессия создаётся с captcha-solver
   * и закрывается, если человек не нужен. Переданная сессия остаётся открытой.
   */
  async acceptInvite(args: SkyvernInviteArgs): Promise<AcceptInviteResult & { session: BrowserSession }> {
    const owned = !args.browserSessionId;
    const opened = args.browserSessionId
      ? { browserSessionId: args.browserSessionId, liveUrl: this.sessionLive.get(args.browserSessionId) ?? null }
      : await this.openBrowserSession();
    const password = args.password ?? generatePassword();
    const existing = args.existing ?? Boolean(args.password);
    try {
      const prompt = inviteTaskPrompt({
        service: args.service,
        agentName: args.agentName,
        email: args.email,
        password,
        existing,
      });
      const r = await this.runTask({
        runId: args.runId,
        url: args.url,
        prompt,
        purpose: `принять приглашение в ${args.service}`,
        schema: INVITE_OUTPUT_SCHEMA,
        maxSteps: args.maxSteps ?? 30,
        timeoutMs: args.timeoutMs,
        browserSessionId: opened.browserSessionId,
        leaveOpen: true,
        expectTotp: true,
        onSession: args.onSession,
        onStep: args.onStep,
      });
      const result = interpretInviteOutput(r.status, r.output, { email: args.email, password, failureReason: r.failureReason });
      // Пароль существующего аккаунта остаётся его паролем, что бы Skyvern ни решил.
      if (existing && args.password && result.status === "accepted") result.password = args.password;
      result.liveUrl = opened.liveUrl;
      result.browserSessionId = opened.browserSessionId;
      if (owned && result.status !== "needs_human") await this.closeBrowserSession(opened.browserSessionId);
      return { ...result, session: r.session };
    } catch (e) {
      if (owned) await this.closeBrowserSession(opened.browserSessionId);
      throw e;
    }
  }

  /** Задача в уже открытой сессии: прочитать ключ или доки, не закрывая браузер. */
  async extract(args: {
    runId: string;
    url: string;
    prompt: string;
    purpose: string;
    schema: unknown;
    browserSessionId: string;
    maxSteps?: number;
    onStep?: (text: string, data?: Record<string, unknown>) => Promise<void> | void;
  }): Promise<{ status: string; output: unknown; failureReason: string | null }> {
    const r = await this.runTask({
      runId: args.runId,
      url: args.url,
      prompt: args.prompt,
      purpose: args.purpose,
      schema: args.schema,
      maxSteps: args.maxSteps ?? 20,
      browserSessionId: args.browserSessionId,
      leaveOpen: true,
      onStep: args.onStep,
    });
    return { status: r.status, output: r.output, failureReason: r.failureReason };
  }

  /** Вход или регистрация по готовой инструкции агента (`POST /skyvern/login`). */
  async runLoginOrSignup(args: SkyvernLoginArgs): Promise<{ session: BrowserSession; status: string; output: unknown }> {
    const creds = Object.entries(args.credentials)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    const prompt = [
      args.prompt,
      creds ? `\nДанные для формы:\n${creds}` : "",
      "\nЕсли просят код из письма или ссылку для входа — дождись, он придёт сам. Google, Microsoft и SSO не выбирай.",
    ].join("\n");
    const r = await this.runTask({
      runId: args.runId,
      url: args.url,
      prompt,
      purpose: `${args.purpose}: ${args.url}`,
      schema: LOGIN_OUTPUT_SCHEMA,
      maxSteps: 25,
      timeoutMs: args.timeoutMs,
      expectTotp: true,
      onSession: args.onSession,
    });
    return { session: r.session, status: r.status, output: r.output };
  }

  /**
   * Код или ссылка из письма → в Skyvern.
   * В `content` лучше полное тело письма: Skyvern сам вытащит цифры или magic link.
   * Привязываем к последней задаче, чтобы при нескольких код не ушёл не туда.
   */
  async pushCode(v: {
    kind: "code" | "link";
    value: string;
    /** Тема + тело письма — предпочтительный content для TOTP API. */
    emailBody?: string | undefined;
  }): Promise<{ ok: boolean; buffered: boolean; content: string }> {
    const content = totpContent(v);
    const latest = [...this.active.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!latest) {
      if (this.held.size === 0) return { ok: false, buffered: false, content };
      this.pendingTotp.push(content);
      log("skyvern", "код придержан до следующей задачи сессии", {
        kind: v.kind,
        ...(v.kind === "code" ? { code: v.value } : { link: v.value.slice(0, 120) }),
      });
      return { ok: true, buffered: true, content };
    }
    const ok = await this.postTotp(latest, content, v.kind === "code" ? "code" : "link", v.value);
    return { ok, buffered: false, content };
  }

  private async postTotp(
    target: ActiveRun,
    content: string,
    kind: "code" | "link" | "buffered",
    displayValue?: string,
  ): Promise<boolean> {
    const res = await this.fetchImpl(`${this.base}/v1/credentials/totp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        totp_identifier: this.totpIdentifier,
        content,
        source: "email",
        task_id: target.skyvernRunId,
      }),
    });
    const digits = displayValue?.match(/^\d{4,8}$/) ? displayValue : content.match(/\b(\d{4,8})\b/)?.[1];
    await this.store.appendBrowserAction(target.sessionId, {
      type: "code-from-email",
      kind,
      delivered: res.ok,
      totpContent: content.slice(0, 500),
      ...(digits ? { code: digits } : kind === "link" ? { link: displayValue ?? content.slice(0, 200) } : {}),
    });
    if (!res.ok) {
      warn("skyvern", "не удалось передать код", { status: res.status, body: (await res.text()).slice(0, 300) });
      return false;
    }
    log("skyvern", "код из письма передан в Skyvern TOTP", {
      kind,
      skyvernRunId: target.skyvernRunId,
      totpIdentifier: this.totpIdentifier,
      ...(digits ? { code: digits } : { link: (displayValue ?? content).slice(0, 120) }),
    });
    return true;
  }

  private async runTask(args: {
    runId: string;
    url: string;
    prompt: string;
    purpose: string;
    schema: unknown;
    maxSteps: number;
    timeoutMs?: number | undefined;
    browserSessionId?: string | undefined;
    /** Не помечать сессию закрытой: следующая задача или человек ещё в ней. */
    leaveOpen?: boolean | undefined;
    /** В журнале: задача может ждать код из письма. */
    expectTotp?: boolean | undefined;
    onSession?: ((session: BrowserSession) => Promise<void>) | undefined;
    onStep?: ((text: string, data?: Record<string, unknown>) => Promise<void> | void) | undefined;
  }): Promise<{ session: BrowserSession; status: string; output: unknown; failureReason: string | null }> {
    const res = await this.fetchImpl(`${this.base}/v1/run/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        prompt: args.prompt,
        url: args.url,
        engine: "skyvern-2.0",
        title: args.purpose,
        max_steps: args.maxSteps,
        data_extraction_schema: args.schema,
        totp_identifier: this.totpIdentifier,
        ...(args.browserSessionId ? { browser_session_id: args.browserSessionId } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Skyvern ${res.status}: ${await res.text()}`);
    const created = (await res.json()) as { run_id: string; app_url?: string | null };
    const skyvernRunId = created.run_id;

    const metaId = args.browserSessionId ? `skyvern-${args.browserSessionId}` : `skyvern-${skyvernRunId}`;
    const meta: BrowserSession = this.metas.get(metaId) ?? {
      id: metaId,
      runId: args.runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      provider: "skyvern",
      purpose: args.purpose,
      hasVideo: false,
      liveUrl: (args.browserSessionId ? this.sessionLive.get(args.browserSessionId) : null) ?? created.app_url ?? null,
    };
    meta.purpose = args.purpose;
    if (!meta.liveUrl) meta.liveUrl = created.app_url ?? null;
    const run = { skyvernRunId, sessionId: meta.id, runId: args.runId, startedAt: Date.now() };
    this.active.set(skyvernRunId, run);
    this.metas.set(meta.id, meta);
    const buffered = this.pendingTotp.splice(0);
    for (const content of buffered) await this.postTotp(run, content, "buffered");
    await this.store.saveBrowserSession(meta);
    await this.store.appendBrowserAction(meta.id, { type: "skyvern.start", purpose: args.purpose, url: args.url, appUrl: created.app_url ?? null });
    await args.onSession?.(meta);
    await args.onStep?.(`Skyvern: ${args.purpose}`, { sessionId: meta.id, appUrl: created.app_url ?? null });
    if (args.expectTotp) {
      await args.onStep?.(
        `Skyvern ждёт код или ссылку из письма на ${this.totpIdentifier} — runtime прочитает письмо и передаст в TOTP сам`,
      );
    }

    const deadline = Date.now() + (args.timeoutMs ?? 15 * 60 * 1000);
    let status = "running";
    let output: unknown = null;
    let failureReason: string | null = null;
    let recordingUrl: string | null = null;
    try {
      while (Date.now() < deadline) {
        if (this.canceledRuns.has(args.runId)) {
          status = "canceled";
          failureReason = "остановлено пользователем";
          await this.cancel(skyvernRunId);
          await this.store.appendBrowserAction(meta.id, { type: "skyvern.finish", status, failureReason });
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
        const r = await this.fetchImpl(`${this.base}/v1/runs/${skyvernRunId}`, { headers: { "x-api-key": this.apiKey } });
        if (!r.ok) continue;
        const json = (await r.json()) as {
          status: string;
          output?: unknown;
          recording_url?: string | null;
          failure_reason?: string | null;
        };
        if (json.status !== status) {
          status = json.status;
          await args.onStep?.(`Skyvern: ${status}`);
        }
        if (TERMINAL.has(status)) {
          output = json.output ?? null;
          recordingUrl = json.recording_url ?? null;
          failureReason = json.failure_reason ?? null;
          await this.store.appendBrowserAction(meta.id, { type: "skyvern.finish", status, failureReason });
          break;
        }
      }
      if (!TERMINAL.has(status)) {
        status = "timed_out";
        failureReason = "runtime не дождался завершения задачи Skyvern";
        await this.cancel(skyvernRunId);
        await this.store.appendBrowserAction(meta.id, { type: "skyvern.finish", status, failureReason });
      }
    } finally {
      this.active.delete(skyvernRunId);
      this.canceledRuns.delete(args.runId);
    }

    if (recordingUrl) {
      try {
        meta.hasVideo = await downloadUrlTo(recordingUrl, this.store.videoPath(meta.id));
      } catch (e) {
        warn("skyvern", "не удалось скачать ролик", { error: String(e) });
      }
    }
    if (!args.leaveOpen) {
      meta.finishedAt = new Date().toISOString();
      this.metas.delete(meta.id);
    }
    await this.store.saveBrowserSession(meta);
    log("skyvern", "задача завершена", { skyvernRunId, status, hasVideo: meta.hasVideo });
    return { session: meta, status, output, failureReason };
  }

  private async cancel(skyvernRunId: string): Promise<void> {
    try {
      await this.fetchImpl(`${this.base}/v1/runs/${skyvernRunId}/cancel`, {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
      });
    } catch (e) {
      warn("skyvern", "не удалось отменить задачу", { error: String(e) });
    }
  }
}
