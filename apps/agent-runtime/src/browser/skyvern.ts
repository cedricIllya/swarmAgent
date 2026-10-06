import type { BrowserSession } from "@swarm/contracts";
import type { Store } from "../store";
import { downloadUrlTo } from "./recordings";
import { blockerKind, looksLikeServiceApprovalWait } from "../connect";
import { generatePassword, type AcceptInviteResult } from "./invite";
import { registrationNameLine } from "./person-name";
import { currentUrlFromCdp, exportStorageFromCdp, type BrowserStorageState } from "./session-transfer";
import { log, warn } from "../log";

/**
 * Skyvern — только онбординг: принять приглашение, зарегистрироваться, войти.
 * Задачи внутри сервиса — свой Chromium.
 *
 * Код и magic link в страницу не вставляем. Задача стартует с `totp_identifier` = почта
 * агента. Письмо целиком уходит в `POST /v1/credentials/totp` с тем же идентификатором,
 * Skyvern сам достаёт код или открывает ссылку.
 * https://docs.skyvern.com/credentials/totp
 */

const TERMINAL = new Set(["completed", "failed", "terminated", "canceled", "timed_out"]);
const TOTP_CONTENT_MAX = 6000;
const TOTP_BUFFER_TTL_MS = 15 * 60 * 1000;
/** Столько провалов solve_captcha подряд (по ~5 минут каждый) — капчу отдаём человеку. */
const CAPTCHA_STALL_ATTEMPTS = 2;
/** Сколько раз одно письмо пробуем отдать в TOTP, прежде чем оставить его в покое. */
const TOTP_POST_ATTEMPTS = 3;
const CAPTCHA_CHECK_INTERVAL_MS = 60 * 1000;

interface SkyvernStep {
  status?: string;
  output?: { actions_and_results?: Array<[{ action_type?: string }, Array<{ success?: boolean }>?]> } | null;
}

/**
 * Сколько последних шагов задачи подряд упали на solve_captcha. Идущий шаг не считаем:
 * он может быть очередной попыткой, которая ещё не провалилась.
 */
export function countCaptchaFailures(steps: SkyvernStep[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step) break;
    const actions = step.output?.actions_and_results ?? [];
    const captcha = actions.some(([action]) => action?.action_type === "solve_captcha");
    if (!captcha) {
      if (step.status === "running" && n === 0 && actions.length === 0) continue;
      break;
    }
    if (step.status === "running") continue;
    const solved = actions.some(([action, results]) => action?.action_type === "solve_captcha" && (results ?? []).some((r) => r.success));
    if (solved) break;
    n++;
  }
  return n;
}

/** Страница ждёт письмо: не выдумывать код, не брать его со страницы, не пропускать шаг. */
const TOTP_WAIT =
  "Если страница просит код из письма или присылает ссылку подтверждения или входа — подожди. Письмо придёт в этот ящик и будет передано в эту задачу. Код не выдумывай, не бери его со страницы и не пропускай этот шаг.";

/**
 * Тело для TOTP: первая строка — тема, дальше plain text.
 * Нет текста — HTML без тегов и со схлопнутыми пробелами. Код из письма не вырезаем.
 */
export function skyvernInboxContent(email: { subject: string; text: string; html: string }): string {
  const subject = email.subject.replace(/\s+/g, " ").trim();
  const plain = email.text.trim();
  const body = plain || stripHtml(email.html);
  return `${subject}\n${body}`.slice(0, TOTP_CONTENT_MAX);
}

function codePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return " ";
  return String.fromCodePoint(code);
}

function stripHtml(html: string): string {
  const links: string[] = [];
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/\s(?:href|src)\s*=\s*["']([^"']+)["']/gi, (_full, url: string) => {
      links.push(url);
      return " ";
    });
  const text = withoutScripts
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const missing = links.filter((url) => url && !text.includes(url));
  return [text, ...missing].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function totpSource(service: string): string {
  const name = service.replace(/\s+/g, " ").trim() || "mail";
  return `${name}-inbox`;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "mail";
  }
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
  firstName?: string | null;
  lastName?: string | null;
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
  /** Имя сервиса для `source` в TOTP. Иначе — хост url. */
  service?: string;
  browserSessionId?: string | null;
  onSession?: (session: BrowserSession) => Promise<void>;
}

interface SkyvernTaskResult {
  session: BrowserSession;
  status: string;
  output: unknown;
  failureReason: string | null;
  /** Задача остановлена из-за капчи, которую решатель не прошёл. */
  captchaStall: boolean;
}

interface ActiveRun {
  skyvernRunId: string;
  /** Для задач 2.0 Skyvern принимает в TOTP только workflow_run_id, а не tsk_v2_. */
  workflowRunId: string | null;
  sessionId: string;
  runId: string;
  startedAt: number;
  service: string;
  expectTotp: boolean;
}

/** Адрес задачи для `POST /v1/credentials/totp`: wr_ у задач 2.0, tsk_ у остальных. */
export function totpTarget(run: Pick<ActiveRun, "skyvernRunId" | "workflowRunId">): Record<string, string> {
  if (run.skyvernRunId.startsWith("tsk_v2_")) return run.workflowRunId ? { workflow_run_id: run.workflowRunId } : {};
  return { task_id: run.skyvernRunId };
}

/** `wr_…` из app_url ответа Skyvern: отдельного поля в ответе на создание задачи нет. */
export function workflowRunIdFrom(appUrl: string | null | undefined): string | null {
  return appUrl?.match(/\b(wr_[A-Za-z0-9]+)\b/)?.[1] ?? null;
}

interface TotpOffer {
  /** Письмо забрала задача входа: новый сценарий сейчас не открывать. */
  taken: boolean;
  posted: boolean;
  /** Код, который вернул Skyvern. Пусто — не ошибка: в письме может быть ссылка. */
  code: string | null;
  /** Такое же письмо уже ушло в задачу. */
  duplicate?: boolean;
  /** Задачи ещё нет: письмо ждёт её старта в буфере. */
  deferred?: boolean;
}

/** Текст задачи Skyvern: принять приглашение. Существующий аккаунт — только вход, без нового пароля. */
export function inviteTaskPrompt(args: {
  service: string;
  agentName: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  password: string;
  existing?: boolean;
}): string {
  const identity = [
    `${registrationNameLine(args.agentName, args.firstName, args.lastName)} Адрес электронной почты — только ${args.email}.`,
    "Способ входа — только почта (Continue with email). Google, Microsoft, GitHub, Apple и SSO не выбирай, если есть обычный путь.",
    TOTP_WAIT,
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
  ctx: { email: string; password: string; failureReason?: string | null; captchaStall?: boolean },
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
  // Решатель капчи не справился: свой браузер её тем более не пройдёт, нужен человек в этой же сессии.
  if (ctx.captchaStall && status !== "completed") {
    return { ...base, status: "needs_human", barrierKind: "captcha", notes: notes || "Skyvern не прошёл капчу за отведённое время" };
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
  /** Сессия жива до close или до таймаута: машину в это время не усыпляем. */
  private readonly held = new Map<string, number>();
  private readonly sessionLive = new Map<string, string | null>();
  /** CDP-адрес сессии для экспорта cookies в свой Chromium. */
  private readonly sessionCdp = new Map<string, string | null>();
  private readonly metas = new Map<string, BrowserSession>();
  /** Захват ящика на время задачи входа. Счётчик: внешний вызов и runTask. */
  private mailboxHolds = 0;
  /** Письма до totp_identifier. Живут около 15 минут и уходят в задачу на старте. */
  private readonly totpBuffer: Array<{ at: number; content: string; attempts: number }> = [];
  /** Уже отданные письма, чтобы повтор после отпускания ящика не слать второй раз. */
  private readonly forwarded = new Map<string, number>();
  private onMailboxRelease: (() => void) | null = null;
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

  /** После отпускания ящика разобрать отложенные письма обычным путём. */
  setMailboxReleaseHook(fn: () => void): void {
    this.onMailboxRelease = fn;
  }

  /** Ящик захвачен задачей входа, регистрации или сброса пароля. */
  get mailboxCaptured(): boolean {
    return this.mailboxHolds > 0;
  }

  /** Идёт задача или открыта сессия онбординга. Машину не усыплять; почту само по себе не глотать. */
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

  /** Письмо уже ушло в задачу входа. Повторный разбор не должен открывать новую задачу. */
  wasForwarded(content: string): boolean {
    const body = content.trim().slice(0, TOTP_CONTENT_MAX);
    if (!body) return false;
    this.pruneTotp();
    return this.forwarded.has(body);
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

  /** Настоящий адрес вкладки живой сессии; null, если CDP недоступен. */
  async currentUrl(browserSessionId: string): Promise<string | null> {
    const cdpUrl = await this.browserAddress(browserSessionId);
    if (!cdpUrl) return null;
    try {
      return await currentUrlFromCdp({ cdpUrl, apiKey: this.apiKey });
    } catch (e) {
      warn("skyvern", "адрес вкладки по CDP не прочитался", { error: String(e) });
      return null;
    }
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
    this.captureMailbox();
    const owned = !args.browserSessionId;
    let opened: { browserSessionId: string; liveUrl: string | null } | null = null;
    try {
      opened = args.browserSessionId
        ? { browserSessionId: args.browserSessionId, liveUrl: this.sessionLive.get(args.browserSessionId) ?? null }
        : await this.openBrowserSession();
      const password = args.password ?? generatePassword();
      const existing = args.existing ?? Boolean(args.password);
      const prompt = inviteTaskPrompt({
        service: args.service,
        agentName: args.agentName,
        firstName: args.firstName ?? null,
        lastName: args.lastName ?? null,
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
        service: args.service,
        onSession: args.onSession,
        onStep: args.onStep,
      });
      const result = interpretInviteOutput(r.status, r.output, {
        email: args.email,
        password,
        failureReason: r.failureReason,
        captchaStall: r.captchaStall,
      });
      // Пароль существующего аккаунта остаётся его паролем, что бы Skyvern ни решил.
      if (existing && args.password && result.status === "accepted") result.password = args.password;
      result.liveUrl = opened.liveUrl;
      result.browserSessionId = opened.browserSessionId;
      if (owned && result.status !== "needs_human") await this.closeBrowserSession(opened.browserSessionId);
      return { ...result, session: r.session };
    } catch (e) {
      if (owned && opened) await this.closeBrowserSession(opened.browserSessionId);
      throw e;
    } finally {
      this.releaseMailbox();
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
    /** Сервис может заново спросить код из письма (step-up перед настройками): держать ящик. */
    expectTotp?: boolean;
    service?: string;
    onStep?: (text: string, data?: Record<string, unknown>) => Promise<void> | void;
  }): Promise<{ status: string; output: unknown; failureReason: string | null }> {
    const r = await this.runTask({
      runId: args.runId,
      url: args.url,
      prompt: args.expectTotp ? `${args.prompt}\n${TOTP_WAIT}` : args.prompt,
      purpose: args.purpose,
      schema: args.schema,
      maxSteps: args.maxSteps ?? 20,
      browserSessionId: args.browserSessionId,
      leaveOpen: true,
      expectTotp: args.expectTotp,
      service: args.service,
      onStep: args.onStep,
    });
    return { status: r.status, output: r.output, failureReason: r.failureReason };
  }

  /** Вход или регистрация по готовой инструкции агента (`POST /skyvern/login`). */
  async runLoginOrSignup(args: SkyvernLoginArgs): Promise<{ session: BrowserSession; status: string; output: unknown }> {
    this.captureMailbox();
    let owned: string | null = null;
    try {
      let browserSessionId = args.browserSessionId ?? null;
      if (!browserSessionId) {
        const opened = await this.openBrowserSession();
        browserSessionId = opened.browserSessionId;
        owned = browserSessionId;
      }
      const creds = Object.entries(args.credentials)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const prompt = [args.prompt, creds ? `\nДанные для формы:\n${creds}` : "", "", TOTP_WAIT, "Google, Microsoft и SSO не выбирай."].join("\n");
      const r = await this.runTask({
        runId: args.runId,
        url: args.url,
        prompt,
        purpose: `${args.purpose}: ${args.url}`,
        schema: LOGIN_OUTPUT_SCHEMA,
        maxSteps: 25,
        timeoutMs: args.timeoutMs,
        browserSessionId,
        expectTotp: true,
        service: args.service?.trim() || hostLabel(args.url),
        onSession: args.onSession,
      });
      if (owned) {
        await this.closeBrowserSession(owned);
        owned = null;
      }
      return { session: r.session, status: r.status, output: r.output };
    } finally {
      if (owned) await this.closeBrowserSession(owned).catch(() => undefined);
      this.releaseMailbox();
    }
  }

  /**
   * Письмо целиком → в задачу входа. Код и ссылку не разбираем.
   * Нет живой задачи — кладём в буфер на 15 минут. Захват ящика значит «не открывать новый сценарий».
   */
  async offerEmail(content: string): Promise<TotpOffer> {
    const body = content.trim().slice(0, TOTP_CONTENT_MAX);
    if (!body) return { taken: false, posted: false, code: null };
    this.pruneTotp();
    const tasks = this.totpTasks();
    if (tasks.length > 0) {
      if (this.forwarded.has(body)) return { taken: true, posted: false, code: null, duplicate: true };
      const target = [...tasks].sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
      const posted = await this.postTotp(target, body);
      if (posted.ok) this.forwarded.set(body, Date.now());
      else this.rememberTotp(body, 1);
      return { taken: true, posted: posted.ok, code: posted.code };
    }
    if (!this.forwarded.has(body)) this.rememberTotp(body);
    if (this.mailboxCaptured) {
      log("skyvern", "письмо придержано до старта задачи входа", { totpIdentifier: this.totpIdentifier });
      return { taken: true, posted: false, code: null, deferred: true };
    }
    return { taken: false, posted: false, code: null };
  }

  private captureMailbox(): void {
    this.mailboxHolds++;
  }

  private releaseMailbox(): void {
    if (this.mailboxHolds === 0) return;
    this.mailboxHolds--;
    if (this.mailboxHolds === 0) this.onMailboxRelease?.();
  }

  private totpTasks(): ActiveRun[] {
    return [...this.active.values()].filter((t) => t.expectTotp);
  }

  private pruneTotp(): void {
    const cutoff = Date.now() - TOTP_BUFFER_TTL_MS;
    while (this.totpBuffer.length > 0 && this.totpBuffer[0]!.at < cutoff) this.totpBuffer.shift();
    for (const [key, at] of this.forwarded) if (at < cutoff) this.forwarded.delete(key);
  }

  private rememberTotp(content: string, attempts = 0): void {
    this.pruneTotp();
    const known = this.totpBuffer.find((item) => item.content === content);
    if (known) {
      known.attempts = Math.max(known.attempts, attempts);
      return;
    }
    if (this.totpBuffer.length >= 30) this.totpBuffer.shift();
    this.totpBuffer.push({ at: Date.now(), content, attempts });
  }

  /** Буфер → в задачу. Неудачный POST возвращается в буфер и повторяется из опроса задачи, но не бесконечно. */
  private async flushBuffer(task: ActiveRun): Promise<void> {
    this.pruneTotp();
    const pending = this.totpBuffer.splice(0);
    for (const item of pending) {
      if (item.attempts >= TOTP_POST_ATTEMPTS) continue;
      const posted = await this.postTotp(task, item.content);
      if (posted.ok) this.forwarded.set(item.content, Date.now());
      else this.rememberTotp(item.content, item.attempts + 1);
    }
  }

  /**
   * POST /v1/credentials/totp. Ошибка логируется и не бросается: вход продолжается.
   * `task_id` только когда известна ровно одна ждущая задача.
   */
  private async postTotp(target: ActiveRun | null, content: string): Promise<{ ok: boolean; code: string | null }> {
    const payload: Record<string, string> = {
      totp_identifier: this.totpIdentifier,
      content,
      source: totpSource(target?.service ?? "mail"),
      ...(target && this.totpTasks().length === 1 ? totpTarget(target) : {}),
    };
    try {
      const res = await this.fetchImpl(`${this.base}/v1/credentials/totp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify(payload),
      });
      const raw = await res.text();
      if (!res.ok) {
        warn("skyvern", "не удалось передать письмо в TOTP", { status: res.status, body: raw.slice(0, 300) });
        return { ok: false, code: null };
      }
      let code: string | null = null;
      try {
        const parsed = JSON.parse(raw) as { code?: unknown };
        code = typeof parsed.code === "string" && parsed.code.trim() ? parsed.code.trim() : null;
      } catch {
        code = null;
      }
      log("skyvern", "письмо передано в TOTP", {
        totpIdentifier: this.totpIdentifier,
        ...(target ? { skyvernRunId: target.skyvernRunId } : {}),
        code,
      });
      if (target) {
        await this.store.appendBrowserAction(target.sessionId, {
          type: "code-from-email",
          delivered: true,
          totpContent: content.slice(0, 500),
          ...(code ? { code } : {}),
        });
      }
      return { ok: true, code };
    } catch (e) {
      warn("skyvern", "не удалось передать письмо в TOTP", { error: String(e) });
      return { ok: false, code: null };
    }
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
    /** Задача входа, регистрации или сброса: захватить ящик и ждать письмо. */
    expectTotp?: boolean | undefined;
    service?: string | undefined;
    onSession?: ((session: BrowserSession) => Promise<void>) | undefined;
    onStep?: ((text: string, data?: Record<string, unknown>) => Promise<void> | void) | undefined;
  }): Promise<SkyvernTaskResult> {
    if (args.expectTotp) this.captureMailbox();
    try {
      if (args.expectTotp && !args.browserSessionId) throw new Error("задаче входа нужен browser_session_id");
      return await this.runTaskBody(args);
    } finally {
      if (args.expectTotp) this.releaseMailbox();
    }
  }

  private async runTaskBody(args: {
    runId: string;
    url: string;
    prompt: string;
    purpose: string;
    schema: unknown;
    maxSteps: number;
    timeoutMs?: number | undefined;
    browserSessionId?: string | undefined;
    leaveOpen?: boolean | undefined;
    expectTotp?: boolean | undefined;
    service?: string | undefined;
    onSession?: ((session: BrowserSession) => Promise<void>) | undefined;
    onStep?: ((text: string, data?: Record<string, unknown>) => Promise<void> | void) | undefined;
  }): Promise<SkyvernTaskResult> {
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
    const run: ActiveRun = {
      skyvernRunId,
      workflowRunId: workflowRunIdFrom(created.app_url),
      sessionId: meta.id,
      runId: args.runId,
      startedAt: Date.now(),
      service: args.service?.trim() || "mail",
      expectTotp: Boolean(args.expectTotp),
    };
    this.active.set(skyvernRunId, run);
    this.metas.set(meta.id, meta);
    if (run.expectTotp) await this.flushBuffer(run);
    await this.store.saveBrowserSession(meta);
    await this.store.appendBrowserAction(meta.id, { type: "skyvern.start", purpose: args.purpose, url: args.url, appUrl: created.app_url ?? null });
    await args.onSession?.(meta);
    await args.onStep?.(`Skyvern: ${args.purpose}`, { sessionId: meta.id, appUrl: created.app_url ?? null });
    // Ящик захвачен на всякий случай: страница может спросить код. В журнал это не пишем,
    // пока письмо реально не передано в задачу — иначе кажется, что код ждём уже сейчас.

    const deadline = Date.now() + (args.timeoutMs ?? 15 * 60 * 1000);
    let status = "running";
    let output: unknown = null;
    let failureReason: string | null = null;
    let recordingUrl: string | null = null;
    let captchaStall = false;
    let nextCaptchaCheck = Date.now() + CAPTCHA_CHECK_INTERVAL_MS;
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
        if (run.expectTotp && this.totpBuffer.length > 0) await this.flushBuffer(run);
        if (Date.now() >= nextCaptchaCheck) {
          nextCaptchaCheck = Date.now() + CAPTCHA_CHECK_INTERVAL_MS;
          if (await this.captchaStalled(skyvernRunId)) {
            captchaStall = true;
            status = "terminated";
            failureReason = "Skyvern не прошёл капчу";
            await this.cancel(skyvernRunId);
            await args.onStep?.("Skyvern не прошёл капчу: нужен человек в этой же сессии");
            await this.store.appendBrowserAction(meta.id, { type: "skyvern.finish", status, failureReason });
            break;
          }
        }
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
        captchaStall = await this.captchaStalled(skyvernRunId, 1);
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
    log("skyvern", "задача завершена", { skyvernRunId, status, hasVideo: meta.hasVideo, captchaStall });
    return { session: meta, status, output, failureReason, captchaStall };
  }

  /**
   * Застрял ли Skyvern на капче: последние шаги текущего блока — провалы solve_captcha.
   * Таймлайн задачи 2.0 → task_id идущего блока → его шаги. Любая ошибка опроса — «нет».
   */
  private async captchaStalled(skyvernRunId: string, attempts = CAPTCHA_STALL_ATTEMPTS): Promise<boolean> {
    try {
      const tl = await this.fetchImpl(`${this.base}/v1/runs/${skyvernRunId}/timeline`, { headers: { "x-api-key": this.apiKey } });
      if (!tl.ok) return false;
      const timeline = (await tl.json()) as Array<{ type?: string; block?: { task_id?: string | null; status?: string } | null }>;
      const current = timeline.find((t) => t.type === "block" && t.block?.task_id) ?? null;
      const taskId = current?.block?.task_id;
      if (!taskId) return false;
      const st = await this.fetchImpl(`${this.base}/api/v1/tasks/${taskId}/steps`, { headers: { "x-api-key": this.apiKey } });
      if (!st.ok) return false;
      const steps = (await st.json()) as SkyvernStep[];
      if (!Array.isArray(steps)) return false;
      const failures = countCaptchaFailures(steps);
      if (failures > 0) log("skyvern", "капча не решается", { skyvernRunId, taskId, failures });
      return failures >= attempts;
    } catch (e) {
      warn("skyvern", "не удалось проверить капчу", { error: String(e) });
      return false;
    }
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
