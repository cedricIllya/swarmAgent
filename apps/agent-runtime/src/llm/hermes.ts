import { parseOpenRouterUsage } from "@swarm/usage";
import { Agent, fetch as undiciFetch } from "undici";
import { assistantText, type OpenRouterClient, type ChatResult } from "./openrouter";
import type { LlmCostLedger } from "./cost-ledger";
import { warn } from "../core/log";

export interface HermesClientOptions {
  apiUrl: string;
  apiKey: string;
  fallback: OpenRouterClient;
  fetchImpl?: typeof fetch;
  /** Сколько ждать поднятия api_server после рестарта, прежде чем ответить без инструментов. */
  readyWaitMs?: number;
  /** Пауза перед повтором временного отказа Hermes. 0 — сразу. */
  httpRetryDelayMs?: number;
  /** Фактические `usage.cost` вызовов OpenRouter за время хода. */
  costs?: LlmCostLedger;
}

export interface HermesSessionSpend {
  usd: number;
  /** `actual` — сверка с провайдером, `estimated` — прайс Hermes, пока сверки нет. */
  source: "actual" | "estimated" | "none";
}

/**
 * Сумма, которую Hermes записал в сессию.
 * `GET /api/sessions/:id` отдаёт её внутри `session`, старый ответ клал на корень.
 * Фактическое списание OpenRouter важнее оценки по прайсу.
 */
export function hermesSessionSpend(body: {
  actual_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
  session?: { actual_cost_usd?: unknown; estimated_cost_usd?: unknown } | null;
}): HermesSessionSpend {
  const nested = body.session;
  const session = nested && typeof nested === "object" ? nested : body;
  const actual = positive(session.actual_cost_usd);
  if (actual > 0) return { usd: actual, source: "actual" };
  const estimated = positive(session.estimated_cost_usd);
  if (estimated > 0) return { usd: estimated, source: "estimated" };
  return { usd: 0, source: "none" };
}

export function hermesSessionCostUsd(body: {
  actual_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
  session?: { actual_cost_usd?: unknown; estimated_cost_usd?: unknown } | null;
}): number {
  return hermesSessionSpend(body).usd;
}

/**
 * Модель иногда пишет вызов инструмента текстом (`<function_calls>…`, `<tool_call>…`), когда
 * такого инструмента нет. В чат человеку эта разметка попадать не должна: вызовом она не стала.
 */
export function stripToolMarkup(text: string): string {
  const closed = /<(function_calls|tool_call|invoke)\b[^>]*>[\s\S]*?<\/\1>/g;
  const open = /<(function_calls|tool_call|invoke)\b[^>]*>[\s\S]*$/;
  // Модель пересказывает свои HTTP-вызовы к runtime блоками ```json { "runId": … } ``` —
  // человеку это внутренняя кухня, а не ответ.
  const requestBlock = /(?:^|\n)[ \t]*(?:POST|GET)?[ \t]*```(?:json|bash|http)?\s*(?:POST|GET)?\s*\{[\s\S]*?\}\s*```/g;
  return text
    .replace(closed, "")
    .replace(open, "")
    .replace(requestBlock, (block) => (/"(runId|sessionId|instruction|serviceSlug|purpose|kind)"\s*:/.test(block) ? "\n" : block))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Сколько длится ход с инструментами. Hermes отвечает только в конце хода. */
export const HERMES_TURN_MS = 20 * 60 * 1000;

/** Плановую проверку прервало сообщение человека: ход не доделываем и в OpenRouter не уходим. */
export class HermesInterrupted extends Error {
  constructor() {
    super("ход уступил сообщению человека");
    this.name = "HermesInterrupted";
  }
}

/**
 * Встроенный fetch рвёт запрос, если заголовков нет 5 минут. Ход Hermes с браузером
 * идёт дольше: runtime бросал его, повторял тот же запрос и отвечал без инструментов,
 * а Hermes продолжал работу в фоне. Предел хода задаёт только HERMES_TURN_MS.
 */
const turnDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

const hermesFetch = ((input: string, init?: RequestInit) =>
  undiciFetch(input, { ...(init as object), dispatcher: turnDispatcher })) as unknown as typeof fetch;

/** Коды, при которых запрос до Hermes не дошёл: повтор после подъёма порта безопасен. */
const NOT_LISTENING = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** Временный отказ уже поднятого сервера. 502 с пустым итогом хода сюда не входит. */
const HTTP_RETRY = new Set([408, 409, 429, 500, 503, 504]);

/**
 * Hermes не принял соединение: сервер ещё поднимается. Запрос до него не дошёл, повтор безопасен.
 * Обрыв уже отправленного хода (ECONNRESET и таймаут заголовков) сюда не попадает.
 */
export function notListening(e: unknown): boolean {
  let match = false;
  const seen = new Set<unknown>();
  const walk = (err: unknown) => {
    if (!err || typeof err !== "object" || seen.has(err)) return;
    seen.add(err);
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && NOT_LISTENING.has(code)) match = true;
    walk((err as { cause?: unknown }).cause);
    const nested = (err as { errors?: unknown }).errors;
    if (Array.isArray(nested)) nested.forEach(walk);
  };
  walk(e);
  return match;
}

/** Ход агента кончился без текста. Сервер при этом жив, инструменты были. */
export function agentRunFailed(body: string): boolean {
  return /agent_incomplete|agent_failed|did not produce a response|No response generated|max_iterations/i.test(body);
}

function retryableHttp(status: number, body: string): boolean {
  if (agentRunFailed(body)) return false;
  return HTTP_RETRY.has(status) || status === 502;
}

/** Текст человеку: без имени Hermes и без сырого тела ошибки. */
export function hermesFailureText(status: number, body: string): string {
  if (status === 401 || status === 403) return "Ход не завершился: доступ к модели отклонён.";
  if (agentRunFailed(body)) return "Ход не завершился, ответ сервиса пустой.";
  return "Ход не завершился, сервис не ответил.";
}

function turnWasAborted(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

interface HermesCompletion {
  model?: string;
  hermes?: { completed?: boolean; failed?: boolean; partial?: boolean };
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: unknown };
  }>;
}

function turnIncomplete(json: HermesCompletion): boolean {
  const choice = json.choices?.[0];
  const finish = choice?.finish_reason;
  if (finish === "error" || finish === "length") return true;
  const meta = json.hermes;
  if (!meta) return false;
  return meta.failed === true || meta.partial === true || meta.completed === false;
}

function positive(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Hermes работает в соседнем контейнере той же машины и слушает OpenAI-совместимый
 * `api_server`. У него есть MCP, скиллы и память — все задачи с инструментами идут сюда.
 * Прямой OpenRouter без инструментов — только если порт так и не поднялся.
 * Ошибка уже начатого хода (пустой итог, 502) остаётся ходом Hermes: инструменты были.
 */
export class HermesClient {
  private readonly f: typeof fetch;
  /** Накопленная стоимость сессии, уже записанная в usage. Сессия Hermes живёт дольше одного хода. */
  private readonly sessionCostSeen = new Map<string, number>();
  /** api_server принимает один ход. Второй в это же время ждёт сессию, пока первый не отпустит. */
  private gate: Promise<void> = Promise.resolve();
  private turns = 0;
  /** Ход плановой проверки: сообщение человека его обрывает. */
  private background: AbortController | null = null;

  constructor(private readonly opts: HermesClientOptions) {
    this.f = opts.fetchImpl ?? hermesFetch;
  }

  /** Ход идёт или ждёт очереди. Задачи за ним стоят без шагов, но не зависли. */
  get busy(): boolean {
    return this.turns > 0;
  }

  private authHeaders(): Record<string, string> {
    return this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {};
  }

  /**
   * После рестарта машины control plane присылает тик раньше, чем контейнер Hermes поднял
   * api_server: первый же ход уходил в OpenRouter без инструментов и задача падала.
   * Ждём, пока сервер примет ключ. 401 без ключа Hermes пишет как invalid API key и ход срывается.
   */
  private async awaitReady(signal: AbortSignal): Promise<boolean> {
    // Сторож снимает чужую запись PID через ~80 с молчания порта, s6 повторяет старт с паузой до 80 с.
    const waitMs = this.opts.readyWaitMs ?? 180_000;
    if (waitMs <= 0) return false;
    const until = Date.now() + waitMs;
    for (;;) {
      if (signal.aborted || Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const res = await this.f(`${this.opts.apiUrl}/models`, {
          headers: this.authHeaders(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 401 || res.status === 403) continue;
        return true;
      } catch {
        // ещё не слушает
      }
    }
  }

  /** Письмо и тик не занимают api_server одновременно: Hermes держит одну сессию на ключ. */
  async run(
    prompt: string,
    args: { sessionId: string; system?: string; model: string; signal?: AbortSignal; background?: boolean },
  ): Promise<ChatResult> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turns += 1;
    const own = new AbortController();
    if (args.background) this.background = own;
    // Сообщение человека не стоит в очереди за плановой проверкой.
    else this.background?.abort();
    try {
      await previous;
      if (args.signal?.aborted) throw new DOMException("Задача остановлена", "AbortError");
      return await this.execute(prompt, args, own);
    } finally {
      if (this.background === own) this.background = null;
      this.turns -= 1;
      release();
    }
  }

  private async execute(
    prompt: string,
    args: { sessionId: string; system?: string; model: string; signal?: AbortSignal; background?: boolean },
    own: AbortController,
  ): Promise<ChatResult> {
    const turnId = `${args.sessionId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    this.opts.costs?.begin(turnId);
    let closed = false;
    const closeTurn = (): number => {
      if (closed) return 0;
      closed = true;
      return this.opts.costs?.end(turnId) ?? 0;
    };
    const timeout = AbortSignal.timeout(HERMES_TURN_MS);
    const signal = AbortSignal.any([timeout, own.signal, ...(args.signal ? [args.signal] : [])]);
    const post = () =>
      this.f(`${this.opts.apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          model: args.model,
          user: args.sessionId,
          messages: [
            ...(args.system ? [{ role: "system", content: args.system }] : []),
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
        signal,
      });
    try {
      let res: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await post();
        } catch (e) {
          // Сервер ещё поднимается после рестарта: дождаться и повторить один раз.
          // Оборванный ход не повторяем: Hermes его уже выполняет.
          if (signal.aborted || attempt > 0 || !notListening(e)) throw e;
          if (!(await this.awaitReady(signal))) throw e;
          continue;
        }
        if (res.ok) break;
        const status = res.status;
        const body = await res.text();
        if (attempt === 0 && retryableHttp(status, body)) {
          warn("hermes", "ход не принят, повтор", { status });
          await this.pauseRetry(signal);
          continue;
        }
        const billed = closeTurn();
        warn("hermes", "ход не завершился", { status, error: body.slice(0, 400) });
        return {
          text: hermesFailureText(status, body),
          model: args.model,
          citations: [],
          usedFallback: false,
          incomplete: true,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: billed,
        };
      }
      if (!res?.ok) throw new Error("Hermes: нет ответа");
      let json: HermesCompletion;
      try {
        json = (await res.json()) as HermesCompletion;
      } catch {
        const billed = closeTurn();
        warn("hermes", "ход не завершился", { status: res.status, error: "не JSON" });
        return {
          text: hermesFailureText(res.status, ""),
          model: args.model,
          citations: [],
          usedFallback: false,
          incomplete: true,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: billed,
        };
      }
      const usage = parseOpenRouterUsage(json);
      const hermesSession = res.headers.get("x-hermes-session-id");
      const billed = closeTurn();
      usage.costUsd = await this.resolveTurnCost(usage.costUsd, billed, hermesSession);
      return {
        text: stripToolMarkup(assistantText(json.choices?.[0]?.message)),
        model: json.model ?? args.model,
        citations: [],
        usedFallback: false,
        incomplete: turnIncomplete(json),
        ...usage,
      };
    } catch (e) {
      const billed = closeTurn();
      if (own.signal.aborted && !args.signal?.aborted) throw new HermesInterrupted();
      // Отмена и предел хода — не уходим в OpenRouter: Hermes этот ход уже выполняет.
      if (args.signal?.aborted || turnWasAborted(e)) throw e;
      warn("hermes", "api_server недоступен, отвечаем без инструментов", { error: String(e) });
      const fallback = await this.opts.fallback.chat(
        [
          ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
          { role: "user" as const, content: prompt },
        ],
        {},
        args.model,
      );
      return { ...fallback, costUsd: fallback.costUsd + billed, usedFallback: true };
    }
  }

  /** Пауза перед повтором временного отказа. Отмена хода её прерывает. */
  private async pauseRetry(signal: AbortSignal): Promise<void> {
    const ms = this.opts.httpRetryDelayMs ?? 2_000;
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("Задача остановлена", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Сумма `usage.cost` за ход. Если прокси ничего не увидел — стоимость этого
   * ответа, а когда и её нет, прирост сессии Hermes (сначала фактическая, иначе оценка).
   */
  private async resolveTurnCost(completionUsd: number, billedUsd: number, sessionId: string | null): Promise<number> {
    if (billedUsd > 0) {
      if (sessionId) await this.rememberSession(sessionId);
      return billedUsd;
    }
    if (completionUsd > 0 || !sessionId) return completionUsd;
    return this.turnCostUsd(sessionId);
  }

  /**
   * Прирост стоимости сессии с прошлого хода. Ошибка чтения сессии не должна
   * ронять уже полученный ответ и уводить задачу в fallback без инструментов.
   */
  private async turnCostUsd(sessionId: string): Promise<number> {
    const total = await this.fetchSessionTotal(sessionId);
    if (total == null) return 0;
    const prev = this.sessionCostSeen.get(sessionId) ?? 0;
    this.sessionCostSeen.set(sessionId, total);
    return Math.max(0, total - prev);
  }

  /** Запомнить сумму сессии, чтобы следующая оценка не повторила уже записанный ход. */
  private async rememberSession(sessionId: string): Promise<void> {
    const total = await this.fetchSessionTotal(sessionId);
    if (total != null && total > 0) this.sessionCostSeen.set(sessionId, total);
  }

  private async fetchSessionTotal(sessionId: string): Promise<number | null> {
    try {
      const origin = new URL(this.opts.apiUrl).origin;
      const res = await this.f(`${origin}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return hermesSessionCostUsd((await res.json()) as { actual_cost_usd?: unknown; estimated_cost_usd?: unknown });
    } catch (e) {
      warn("hermes", "не удалось прочитать стоимость сессии", { error: String(e) });
      return null;
    }
  }
}
