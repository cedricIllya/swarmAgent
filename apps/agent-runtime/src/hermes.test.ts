import { describe, expect, it, vi } from "vitest";
import { HermesClient, hermesSessionCostUsd, stripToolMarkup } from "./hermes";
import type { OpenRouterClient } from "./openrouter";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function client(fetchImpl: typeof fetch): HermesClient {
  const fallback = { chat: vi.fn() } as unknown as OpenRouterClient;
  return new HermesClient({
    apiUrl: "http://127.0.0.1:8642/v1",
    apiKey: "rt",
    fallback,
    fetchImpl,
  });
}

describe("hermesSessionCostUsd", () => {
  it("prefers reconciled actual cost, otherwise the estimate", () => {
    expect(hermesSessionCostUsd({ actual_cost_usd: 1.5, estimated_cost_usd: 1.2 })).toBe(1.5);
    expect(hermesSessionCostUsd({ actual_cost_usd: 0, estimated_cost_usd: 0.42 })).toBe(0.42);
    expect(hermesSessionCostUsd({})).toBe(0);
  });
});

describe("stripToolMarkup", () => {
  it("вырезает текстовые «вызовы инструментов», обычный текст оставляет", () => {
    const text = [
      "Получено уведомление. Перехожу к подтверждению.",
      '<function_calls> <invoke name="mcp_x_step"> <parameter name="runId">r1</parameter> </invoke> </function_calls>',
      "Готово.",
      "<tool_call>{\"name\":\"x\"}</tool_call>",
    ].join("\n");
    expect(stripToolMarkup(text)).toBe("Получено уведомление. Перехожу к подтверждению.\n\nГотово.");
    expect(stripToolMarkup("Начинаю. <function_calls><invoke name=\"a\">")).toBe("Начинаю.");
    expect(stripToolMarkup("пусто")).toBe("пусто");
  });
});

describe("HermesClient cost", () => {
  it("fills cost from the session when chat completions omit it", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/chat/completions")) {
        return json(
          { model: "m", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } },
          200,
          { "X-Hermes-Session-Id": "api-abc" },
        );
      }
      return json({ estimated_cost_usd: 0.37, actual_cost_usd: 0 });
    });

    const r = await client(fetchImpl as unknown as typeof fetch).run("привет", { sessionId: "run_1", model: "m" });
    expect(r.promptTokens).toBe(100);
    expect(r.costUsd).toBe(0.37);
    expect(r.usedFallback).toBe(false);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe("http://127.0.0.1:8642/api/sessions/api-abc");
  });

  it("marks OpenRouter fallback when Hermes is down", async () => {
    const fallback = {
      chat: vi.fn(async () => ({
        text: "без инструментов",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        model: "m",
        citations: [],
      })),
    } as unknown as OpenRouterClient;
    const c = new HermesClient({
      apiUrl: "http://127.0.0.1:8642/v1",
      apiKey: "rt",
      fallback,
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await c.run("привет", { sessionId: "run_1", model: "m" });
    expect(r.text).toBe("без инструментов");
    expect(r.usedFallback).toBe(true);
  });

  it("does not fall back when the caller aborts the turn", async () => {
    const fallback = { chat: vi.fn() } as unknown as OpenRouterClient;
    const controller = new AbortController();
    const c = new HermesClient({
      apiUrl: "http://127.0.0.1:8642/v1",
      apiKey: "rt",
      fallback,
      fetchImpl: vi.fn(async (_url, init) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as unknown as typeof fetch,
    });
    const pending = c.run("привет", { sessionId: "run_1", model: "m", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.chat).not.toHaveBeenCalled();
  });

  it("records only the increase when the same Hermes session is reused", async () => {
    let total = 1;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith("/chat/completions")) {
        return json(
          { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
          200,
          { "X-Hermes-Session-Id": "api-same" },
        );
      }
      total += 0.25;
      return json({ estimated_cost_usd: total });
    }) as typeof fetch;

    const c = client(fetchImpl);
    expect((await c.run("a", { sessionId: "s", model: "m" })).costUsd).toBeCloseTo(1.25);
    expect((await c.run("b", { sessionId: "s", model: "m" })).costUsd).toBeCloseTo(0.25);
  });

  it("keeps a cost already present on the completion", async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.05 } },
        200,
        { "X-Hermes-Session-Id": "api-abc" },
      ),
    ) as typeof fetch;
    const r = await client(fetchImpl).run("a", { sessionId: "s", model: "m" });
    expect(r.costUsd).toBe(0.05);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
