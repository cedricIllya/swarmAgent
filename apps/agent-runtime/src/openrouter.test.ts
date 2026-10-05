import { describe, expect, it, vi } from "vitest";
import { OpenRouterClient, isTransientModelError } from "./openrouter";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(fetchImpl: typeof fetch, fallbackModels: string[] = []): OpenRouterClient {
  return new OpenRouterClient("key", "deepseek/deepseek-chat", fetchImpl, { retryDelaysMs: [0, 0], fallbackModels });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call: number): Record<string, unknown> {
  return JSON.parse(String(fetchImpl.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;
}

const schema = { jsonSchema: { name: "email_classification", schema: { type: "object" } } };

describe("OpenRouterClient retries", () => {
  it("retries a 429 and returns the next successful classification", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: 429 } }, 429))
      .mockResolvedValueOnce(
        json({
          model: "deepseek/deepseek-chat",
          choices: [{ message: { content: '{"kind":"invite"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0 },
        }),
      );
    const result = await client(fetchImpl).chat([{ role: "user", content: "письмо" }], schema);
    expect(result.text).toBe('{"kind":"invite"}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "nope" }, 401));
    await expect(client(fetchImpl).chat([{ role: "user", content: "x" }], schema)).rejects.toThrow(/OpenRouter 401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries an empty json schema body", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ choices: [{ message: { content: "" } }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: '{"kind":"invite"}' } }] }));
    const result = await client(fetchImpl).chat([{ role: "user", content: "ссылка" }], schema);
    expect(result.text).toContain("invite");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("OpenRouterClient fallback models", () => {
  it("passes fallbacks as `models` without the primary and omits them when none are given", async () => {
    const reply = json({ model: "deepseek/deepseek-chat", choices: [{ message: { content: '{"kind":"other"}' } }] });
    const withFallback = vi.fn<typeof fetch>().mockResolvedValue(reply.clone());
    await client(withFallback, ["openai/gpt-4.1-mini", "deepseek/deepseek-chat"]).chat([{ role: "user", content: "x" }], schema);
    expect(sentBody(withFallback, 0)["model"]).toBe("deepseek/deepseek-chat");
    expect(sentBody(withFallback, 0)["models"]).toEqual(["openai/gpt-4.1-mini"]);

    const bare = vi.fn<typeof fetch>().mockResolvedValue(reply.clone());
    await client(bare).chat([{ role: "user", content: "x" }], schema);
    expect(sentBody(bare, 0)["models"]).toBeUndefined();
  });

  it("repeats an empty json schema answer on the fallback model", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ model: "deepseek/deepseek-chat", choices: [{ message: { content: "" } }] }))
      .mockResolvedValueOnce(json({ model: "openai/gpt-4.1-mini", choices: [{ message: { content: '{"kind":"invite"}' } }] }));
    const result = await client(fetchImpl, ["openai/gpt-4.1-mini"]).chat([{ role: "user", content: "ссылка" }], schema);
    expect(result.text).toContain("invite");
    expect(sentBody(fetchImpl, 1)["model"]).toBe("openai/gpt-4.1-mini");
    expect(sentBody(fetchImpl, 1)["models"]).toBeUndefined();
  });
});

describe("OpenRouterClient fallbacks", () => {
  it("sends the backup model in the same request and retries on it after a 429", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; models?: string[] };
      seen.push(body.model);
      if (seen.length === 1) {
        expect(body.models).toEqual(["openai/gpt-4.1-mini"]);
        return json({ error: { code: 429 } }, 429);
      }
      expect(body.model).toBe("openai/gpt-4.1-mini");
      return json({ choices: [{ message: { content: '{"kind":"invite"}' } }] });
    });
    const result = await client(fetchImpl, ["openai/gpt-4.1-mini"]).chat([{ role: "user", content: "письмо" }], schema);
    expect(result.text).toContain("invite");
    expect(seen).toEqual(["deepseek/deepseek-chat", "openai/gpt-4.1-mini"]);
  });
});

describe("isTransientModelError", () => {
  it("treats rate limits and empty json as retryable, and auth errors as final", () => {
    expect(isTransientModelError(new Error("OpenRouter 429: overloaded"))).toBe(true);
    expect(isTransientModelError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    expect(isTransientModelError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientModelError(new Error("OpenRouter 401: no"))).toBe(false);
  });
});
