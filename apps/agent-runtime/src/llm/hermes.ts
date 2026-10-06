import { parseOpenRouterUsage } from "@swarm/usage";
import type { OpenRouterClient, ChatResult } from "./openrouter";
import { warn } from "../core/log";

export interface HermesClientOptions {
  apiUrl: string;
  apiKey: string;
  fallback: OpenRouterClient;
  fetchImpl?: typeof fetch;
  /** Сколько ждать поднятия api_server после рестарта, прежде чем ответить без инструментов. */
  readyWaitMs?: number;
}

/**
 * Сумма, которую Hermes записал в сессию. `actual_cost_usd` появляется после
 * сверки с провайдером; пока её нет, берём оценку `estimated_cost_usd`.
 * В `/v1/chat/completions` этих полей нет: там только токены.
 */
export function hermesSessionCostUsd(session: {
  actual_cost_usd?: unknown;
  estimated_cost_usd?: unknown;
}): number {
  const actual = positive(session.actual_cost_usd);
  if (actual > 0) return actual;
  return positive(session.estimated_cost_usd);
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

function positive(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Hermes работает в соседнем контейнере той же машины и слушает OpenAI-совместимый
 * `api_server`. У него есть MCP, скиллы и память — все задачи с инструментами идут сюда.
 * Если сервер не отвечает, падаем на прямой OpenRouter без инструментов, чтобы ответить словами.
 */
export class HermesClient {
  private readonly f: typeof fetch;
  /** Накопленная стоимость сессии, уже записанная в usage. Сессия Hermes живёт дольше одного хода. */
  private readonly sessionCostSeen = new Map<string, number>();

  constructor(private readonly opts: HermesClientOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }

  /**
   * После рестарта машины control plane присылает тик раньше, чем контейнер Hermes поднял
   * api_server: первый же ход уходил в OpenRouter без инструментов и задача падала.
   * Любой HTTP-ответ — сервер слушает; ждём только сетевой отказ, и недолго.
   */
  private async awaitReady(signal: AbortSignal): Promise<boolean> {
    const waitMs = this.opts.readyWaitMs ?? 90_000;
    if (waitMs <= 0) return false;
    const until = Date.now() + waitMs;
    for (;;) {
      if (signal.aborted || Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        const res = await this.f(`${this.opts.apiUrl}/models`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]) });
        await res.body?.cancel().catch(() => undefined);
        return true;
      } catch {
        // ещё не слушает
      }
    }
  }

  async run(
    prompt: string,
    args: { sessionId: string; system?: string; model: string; signal?: AbortSignal },
  ): Promise<ChatResult> {
    const timeout = AbortSignal.timeout(20 * 60 * 1000);
    const signal = args.signal ? AbortSignal.any([timeout, args.signal]) : timeout;
    const post = () =>
      this.f(`${this.opts.apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
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
      let res: Response;
      try {
        res = await post();
      } catch (e) {
        // Сетевой отказ — сервер ещё поднимается после рестарта: дождаться и повторить один раз.
        if (signal.aborted) throw e;
        if (!(await this.awaitReady(signal))) throw e;
        res = await post();
      }
      if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const usage = parseOpenRouterUsage(json);
      const hermesSession = res.headers.get("x-hermes-session-id");
      if (usage.costUsd <= 0 && hermesSession) {
        usage.costUsd = await this.turnCostUsd(hermesSession);
      }
      return {
        text: stripToolMarkup(json.choices?.[0]?.message?.content ?? ""),
        model: json.model ?? args.model,
        citations: [],
        usedFallback: false,
        ...usage,
      };
    } catch (e) {
      // Отмена пользователем — не уходим в OpenRouter без инструментов.
      if (args.signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw e;
      warn("hermes", "api_server недоступен, отвечаем без инструментов", { error: String(e) });
      const fallback = await this.opts.fallback.chat(
        [
          ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
          { role: "user" as const, content: prompt },
        ],
        {},
        args.model,
      );
      return { ...fallback, usedFallback: true };
    }
  }

  /**
   * Прирост стоимости сессии с прошлого хода. Ошибка чтения сессии не должна
   * ронять уже полученный ответ и уводить задачу в fallback без инструментов.
   */
  private async turnCostUsd(sessionId: string): Promise<number> {
    try {
      const origin = new URL(this.opts.apiUrl).origin;
      const res = await this.f(`${origin}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return 0;
      const total = hermesSessionCostUsd((await res.json()) as { actual_cost_usd?: unknown; estimated_cost_usd?: unknown });
      const prev = this.sessionCostSeen.get(sessionId) ?? 0;
      this.sessionCostSeen.set(sessionId, total);
      return Math.max(0, total - prev);
    } catch (e) {
      warn("hermes", "не удалось прочитать стоимость сессии", { error: String(e) });
      return 0;
    }
  }
}
