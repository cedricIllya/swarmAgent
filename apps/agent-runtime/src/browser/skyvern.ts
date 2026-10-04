import type { BrowserSession } from "@swarm/contracts";
import type { Store } from "../store";
import { downloadUrlTo } from "./recordings";
import { generatePassword, type AcceptInviteResult } from "./invite";
import { log, warn } from "../log";

/**
 * Skyvern — только онбординг: принять приглашение, зарегистрироваться, войти.
 * Задачи внутри сервиса — Stagehand.
 *
 * Коды и magic link из писем Skyvern сам не получает: runtime принимает письмо на адрес
 * агента и отдаёт его в Skyvern через `POST /v1/credentials/totp` с `totp_identifier`
 * равным этому адресу. Задача запускается с тем же `totp_identifier`, поэтому код
 * попадает в нужный запуск.
 * https://docs.skyvern.com/credentials/totp
 */

const TERMINAL = new Set(["completed", "failed", "terminated", "canceled", "timed_out"]);

export const INVITE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["accepted", "captcha", "expired", "needs_human", "failed"],
      description:
        "accepted — вошли в приложение под адресом агента; captcha — капча или проверка на робота; expired — приглашение недействительно; needs_human — нужен человек (SSO, оплата, вопрос, которого нет в инструкции); failed — иначе",
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
  startedAt: number;
}

/** Текст задачи Skyvern: принять приглашение и зарегистрироваться под почтой агента. */
export function inviteTaskPrompt(args: { service: string; agentName: string; email: string; password: string }): string {
  return [
    `Прими приглашение в ${args.service} и зарегистрируйся (или войди) под адресом ${args.email}. Цель — оказаться внутри приложения: рабочее пространство, список проектов или задач.`,
    "",
    "Правила:",
    `- Везде, где спрашивают имя, вводи «${args.agentName}»; адрес электронной почты — только ${args.email}.`,
    `- Если предлагают задать пароль — используй ровно этот: ${args.password} (и его же в подтверждении). Если просят существующий пароль для этого адреса — тоже этот.`,
    "- Способ входа выбирай только по электронной почте (Continue with email, Sign up with email). Google, Microsoft, GitHub, Apple, SSO не выбирай.",
    "- Если просят код подтверждения из письма — дождись его: код придёт сам, введи его и продолжи. Если написано, что отправлена ссылка для входа (magic link) — тоже жди, ссылка откроется сама.",
    "- Отмечай согласие с условиями, если это нужно для продолжения. Закрывай подсказки и всплывающие окна об обучении.",
    "- Не меняй настройки рабочего пространства, никого не приглашай, ничего не оплачивай, не создавай записей внутри приложения.",
    "- Капча или проверка «я не робот» — остановись с outcome=captcha. Приглашение недействительно или истекло — outcome=expired. Требуют SSO, оплату или данные, которых нет в инструкции — outcome=needs_human.",
    "",
    "Задача завершена, когда ты внутри приложения под этим адресом: outcome=accepted, в final_url — адрес страницы, password_set — задавал ли ты пароль из инструкции.",
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
  const base = {
    accountEmail: ctx.email,
    password: o.password_set ? ctx.password : null,
    steps: 0,
    finalUrl,
    provider: "skyvern" as const,
  };
  if (status === "completed" && o.outcome === "accepted") {
    return { ...base, status: "accepted", notes: notes || `приглашение принято, аккаунт ${ctx.email}` };
  }
  if (o.outcome === "captcha" || o.outcome === "needs_human") {
    return { ...base, status: "needs_human", notes: notes || (o.outcome === "captcha" ? "капча" : "нужен человек") };
  }
  if (o.outcome === "expired") {
    return { ...base, status: "failed", notes: notes || "приглашение недействительно" };
  }
  const reason = ctx.failureReason?.trim() || notes || `Skyvern завершил задачу со статусом ${status}`;
  return { ...base, status: "failed", notes: reason.slice(0, 400) };
}

export class SkyvernClient {
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly apiKey: string,
    private readonly store: Store,
    /** Почта агента: `totp_identifier` всех задач и ключ для передачи кодов. */
    private readonly totpIdentifier: string,
    private readonly base = "https://api.skyvern.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Идёт хотя бы одна задача Skyvern: почта с кодом должна уйти в неё. */
  get busy(): boolean {
    return this.active.size > 0;
  }

  /**
   * Принять приглашение и зарегистрироваться под почтой агента одной задачей Skyvern.
   * Пароль придумывается здесь и попадает в итог только если Skyvern его действительно задал.
   */
  async acceptInvite(args: SkyvernInviteArgs): Promise<AcceptInviteResult & { session: BrowserSession }> {
    const password = args.password ?? generatePassword();
    const prompt = inviteTaskPrompt({ service: args.service, agentName: args.agentName, email: args.email, password });
    const r = await this.runTask({
      runId: args.runId,
      url: args.url,
      prompt,
      purpose: `принять приглашение в ${args.service}`,
      schema: INVITE_OUTPUT_SCHEMA,
      maxSteps: args.maxSteps ?? 30,
      timeoutMs: args.timeoutMs,
      onSession: args.onSession,
      onStep: args.onStep,
    });
    const result = interpretInviteOutput(r.status, r.output, { email: args.email, password, failureReason: r.failureReason });
    // Пароль уже был у агента — он и остаётся паролем аккаунта, что бы Skyvern ни решил.
    if (args.password && result.status === "accepted") result.password = args.password;
    return { ...result, session: r.session };
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
      onSession: args.onSession,
    });
    return { session: r.session, status: r.status, output: r.output };
  }

  /**
   * Код или ссылка из письма → в Skyvern. Привязываем к последней запущенной задаче,
   * чтобы при нескольких задачах код не ушёл не туда.
   */
  async pushCode(v: { kind: "code" | "link"; value: string }): Promise<boolean> {
    const latest = [...this.active.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!latest) return false;
    const res = await this.fetchImpl(`${this.base}/v1/credentials/totp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        totp_identifier: this.totpIdentifier,
        content: v.kind === "code" ? `Your verification code is ${v.value}` : v.value,
        source: "swarm-inbox",
        task_id: latest.skyvernRunId,
      }),
    });
    await this.store.appendBrowserAction(latest.sessionId, { type: "code-from-email", kind: v.kind, delivered: res.ok });
    if (!res.ok) {
      warn("skyvern", "не удалось передать код", { status: res.status, body: (await res.text()).slice(0, 300) });
      return false;
    }
    log("skyvern", "код из письма передан", { kind: v.kind, skyvernRunId: latest.skyvernRunId });
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
      }),
    });
    if (!res.ok) throw new Error(`Skyvern ${res.status}: ${await res.text()}`);
    const created = (await res.json()) as { run_id: string; app_url?: string | null };
    const skyvernRunId = created.run_id;

    const meta: BrowserSession = {
      id: `skyvern-${skyvernRunId}`,
      runId: args.runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      provider: "skyvern",
      purpose: args.purpose,
      hasVideo: false,
      liveUrl: null,
    };
    this.active.set(skyvernRunId, { skyvernRunId, sessionId: meta.id, startedAt: Date.now() });
    await this.store.saveBrowserSession(meta);
    await this.store.appendBrowserAction(meta.id, { type: "skyvern.start", purpose: args.purpose, url: args.url, appUrl: created.app_url ?? null });
    await args.onSession?.(meta);
    await args.onStep?.(`Skyvern: ${args.purpose}`, { sessionId: meta.id, appUrl: created.app_url ?? null });

    const deadline = Date.now() + (args.timeoutMs ?? 15 * 60 * 1000);
    let status = "running";
    let output: unknown = null;
    let failureReason: string | null = null;
    let recordingUrl: string | null = null;
    try {
      while (Date.now() < deadline) {
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
    }

    if (recordingUrl) {
      try {
        meta.hasVideo = await downloadUrlTo(recordingUrl, this.store.videoPath(meta.id));
      } catch (e) {
        warn("skyvern", "не удалось скачать ролик", { error: String(e) });
      }
    }
    meta.finishedAt = new Date().toISOString();
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
