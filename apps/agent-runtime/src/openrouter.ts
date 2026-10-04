import { parseOpenRouterUsage } from "@swarm/usage";

export type ChatContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface ChatMessageIn {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model: string;
}

export interface ChatOptions {
  temperature?: number;
  jsonSchema?: { name: string; schema: unknown };
  maxTokens?: number;
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
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const usage = parseOpenRouterUsage(json);
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      model: json.model ?? model,
      ...usage,
    };
  }
}
