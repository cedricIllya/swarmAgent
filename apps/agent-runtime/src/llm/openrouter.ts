import { parseOpenRouterUsage } from "@swarm/usage";
import { warn } from "../core/log";

/** 429 и 5xx провайдера, и обрыв сети на пробуждении машины. 4xx кроме 408 — сразу наружу. */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 3000];

export function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status = /^OpenRouter (\d{3})\b/.exec(message);
  if (status) return TRANSIENT_STATUS.has(Number(status[1]));
  if (error instanceof SyntaxError) return true;
  return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|aborted/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /** true — ответ собран без Hermes (без MCP/скиллов/терминала). */
  usedFallback?: boolean;
}

export interface ChatOptions {
  temperature?: number;
  jsonSchema?: { name: string; schema: unknown };
  maxTokens?: number;
  /** Подмешать результаты веб-поиска OpenRouter перед ответом модели. */
  webSearch?: { maxResults?: number; includeDomains?: string[] };
}

export interface OpenRouterClientOptions {
  retryDelaysMs?: readonly number[];
  /**
   * Модели, на которые OpenRouter сам переключится, если основная перегружена
   * (429), лежит или отказала по модерации. Пустой ответ по схеме тоже
   * повторяем уже на первой резервной.
   */
  fallbackModels?: readonly string[];
}

/**
 * Прямой вызов OpenRouter для коротких решений (классификация письма,
 * шаги Stagehand). Длинные задачи с инструментами идут через Hermes.
 */
export class OpenRouterClient {
  private readonly retryDelaysMs: readonly number[];
  private readonly fallbackModels: readonly string[];

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel: string,
    private readonly fetchImpl: typeof fetch = fetch,
    options: OpenRouterClientOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.fallbackModels = options.fallbackModels ?? [];
  }

  async chat(messages: ChatMessageIn[], opts: ChatOptions = {}, model = this.defaultModel): Promise<ChatResult> {
    const attempts = this.retryDelaysMs.length + 1;
    let current = model;
    let last: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await this.complete(messages, opts, current);
        if (opts.jsonSchema && !result.text.trim() && attempt < attempts - 1) {
          const next = this.fallbackModels.find((m) => m !== current);
          warn("openrouter", "пустой ответ, повтор", { attempt: attempt + 1, model: result.model, next: next ?? current });
          if (next) current = next;
          await sleep(this.retryDelaysMs[attempt] ?? 0);
          continue;
        }
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!isTransientModelError(err) || attempt === attempts - 1) throw err;
        last = err;
        const next = this.fallbackModels.find((m) => m !== current);
        warn("openrouter", "временная ошибка, повтор", {
          attempt: attempt + 1,
          model: current,
          next: next ?? current,
          error: err.message.slice(0, 180),
        });
        if (next) current = next;
        await sleep(this.retryDelaysMs[attempt] ?? 0);
      }
    }
    throw last ?? new Error("OpenRouter: нет ответа");
  }

  private async complete(messages: ChatMessageIn[], opts: ChatOptions, model: string): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model,
      messages,
      usage: { include: true },
    };
    // `model` — основная, `models` — очередь запасных: OpenRouter идёт по ней при 429/5xx/модерации.
    const fallbacks = this.fallbackModels.filter((m) => m !== model);
    if (fallbacks.length) body["models"] = fallbacks;
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
