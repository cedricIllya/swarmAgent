import { parseOpenRouterUsage } from "@swarm/usage";
import type { OpenRouterClient, ChatResult } from "./openrouter";
import { warn } from "./log";

export interface HermesClientOptions {
  apiUrl: string;
  apiKey: string;
  fallback: OpenRouterClient;
  fetchImpl?: typeof fetch;
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

  async run(prompt: string, args: { sessionId: string; system?: string; model: string }): Promise<ChatResult> {
    try {
      const res = await this.f(`${this.opts.apiUrl}/chat/completions`, {
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
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
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
        text: json.choices?.[0]?.message?.content ?? "",
        model: json.model ?? args.model,
        ...usage,
      };
    } catch (e) {
      warn("hermes", "api_server недоступен, отвечаем без инструментов", { error: String(e) });
      return this.opts.fallback.chat(
        [
          ...(args.system ? [{ role: "system" as const, content: args.system }] : []),
          { role: "user" as const, content: prompt },
        ],
        {},
        args.model,
      );
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
