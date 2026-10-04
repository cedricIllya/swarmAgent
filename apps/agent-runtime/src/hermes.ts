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
 * Hermes работает в соседнем контейнере той же машины и слушает OpenAI-совместимый
 * `api_server`. У него есть MCP, скиллы и память — все задачи с инструментами идут сюда.
 * Если сервер не отвечает, падаем на прямой OpenRouter без инструментов, чтобы ответить словами.
 */
export class HermesClient {
  private readonly f: typeof fetch;

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
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        model: json.model ?? args.model,
        ...parseOpenRouterUsage(json),
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
}
