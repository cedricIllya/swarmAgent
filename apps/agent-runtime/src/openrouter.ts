import { parseOpenRouterUsage } from "@swarm/usage";

export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessageIn {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface WebCitation {
  url: string;
  title: string;
  content: string;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
  /** Источники из веб-поиска, если он был включён. */
  citations: WebCitation[];
}

export interface ChatOptions {
  temperature?: number;
  jsonSchema?: { name: string; schema: unknown };
  maxTokens?: number;
  /** Подмешать результаты веб-поиска OpenRouter перед ответом модели. */
  webSearch?: { maxResults?: number; includeDomains?: string[] };
}

/**
 * Прямой вызов OpenRouter для коротких решений (классификация письма,
 * шаги Stagehand). Длинные задачи с инструментами идут через Hermes.
 */
export class OpenRouterClient {
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessageIn[], opts: ChatOptions = {}, model = this.defaultModel): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      usage: { include: true },
    };
    if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
    if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;
    if (opts.jsonSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: opts.jsonSchema.name, strict: true, schema: opts.jsonSchema.schema },
      };
    }
    if (opts.webSearch) {
      // Плагин `web` ищет ровно один раз на запрос и работает с любой моделью и с json_schema.
      // Движок Exa закреплён: «родной» поиск провайдера не возвращает url_citation, а нам нужны источники.
      const plugin: Record<string, unknown> = { id: "web", engine: "exa", max_results: opts.webSearch.maxResults ?? 5 };
      if (opts.webSearch.includeDomains?.length) plugin["include_domains"] = opts.webSearch.includeDomains;
      body["plugins"] = [plugin];
    }
    const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://swarm-agent.local",
        "X-Title": "Swarm Agent",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string | null;
          annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }>;
        };
      }>;
    };
    const usage = parseOpenRouterUsage(json);
    const message = json.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      model: json.model ?? model,
      citations: parseCitations(message?.annotations),
      ...usage,
    };
  }
}

function parseCitations(
  annotations: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }> | undefined,
): WebCitation[] {
  const out: WebCitation[] = [];
  for (const a of annotations ?? []) {
    const url = a.url_citation?.url;
    if (a.type !== "url_citation" || !url || out.some((c) => c.url === url)) continue;
    out.push({ url, title: a.url_citation?.title ?? "", content: a.url_citation?.content ?? "" });
  }
  return out;
}
