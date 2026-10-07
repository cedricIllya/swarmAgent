import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { LlmCostLedger } from "../../src/llm/cost-ledger";
import { proxyOpenRouter } from "../../src/llm/openrouter-proxy";

function completion(body: unknown): Request {
  return new Request("http://127.0.0.1:8787/openrouter/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer sk-or", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("LlmCostLedger", () => {
  it("sums one turn and keeps overlapping spend on the turn that finishes last", () => {
    const ledger = new LlmCostLedger();
    ledger.begin("a");
    ledger.note(1.5);
    expect(ledger.end("a")).toBeCloseTo(1.5);

    ledger.begin("a");
    ledger.begin("b");
    ledger.note(5);
    expect(ledger.end("a")).toBe(0);
    ledger.note(1);
    expect(ledger.end("b")).toBeCloseTo(6);
  });
});

describe("proxyOpenRouter", () => {
  it("asks OpenRouter for usage and records the billed cost", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as { usage?: { include?: boolean } };
      expect(sent.usage?.include).toBe(true);
      return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.8 } }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const ledger = new LlmCostLedger();
    ledger.begin("t");
    const res = await proxyOpenRouter(completion({ model: "m" }), ledger, fetchImpl as unknown as typeof fetch);
    expect(await res.json()).toMatchObject({ usage: { cost: 0.8 } });
    expect(ledger.end("t")).toBeCloseTo(0.8);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("sums the last streamed usage.cost of one call", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"id":"gen-1","choices":[]}\n'));
          controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":4,"completion_tokens":1,"cost":1.25}}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const ledger = new LlmCostLedger();
    ledger.begin("t");
    const res = await proxyOpenRouter(completion({ model: "m" }), ledger, fetchImpl as unknown as typeof fetch);
    expect(await res.text()).toContain("1.25");
    expect(ledger.end("t")).toBeCloseTo(1.25);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("loads generation stats when the completion has no cost", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/generation?")) {
        return new Response(JSON.stringify({ data: { total_cost: 3.5, tokens_prompt: 8, tokens_completion: 2 } }));
      }
      return new Response(JSON.stringify({ id: "gen-abc", usage: { prompt_tokens: 8, completion_tokens: 2 } }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const ledger = new LlmCostLedger();
    ledger.begin("t");
    await proxyOpenRouter(completion({ model: "m" }), ledger, fetchImpl as unknown as typeof fetch);
    expect(ledger.end("t")).toBeCloseTo(3.5);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("id=gen-abc");
  });
});

describe("openrouter route", () => {
  it("принимает ключ OpenRouter до проверки runtime-токена", async () => {
    const app = new Hono();
    app.all("/openrouter/*", (c) => {
      if (c.req.header("authorization") !== "Bearer or-key") return c.json({ error: "unauthorized" }, 401);
      return c.text("proxied");
    });
    app.use("*", async (c, next) => {
      if (c.req.path === "/health") return next();
      if (c.req.header("authorization") !== "Bearer runtime") return c.json({ error: "unauthorized" }, 401);
      return next();
    });
    app.get("/health", (c) => c.text("ok"));
    app.get("/state", (c) => c.text("state"));

    expect(await (await app.request("/openrouter/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer or-key" } })).text()).toBe("proxied");
    expect((await app.request("/state", { headers: { Authorization: "Bearer or-key" } })).status).toBe(401);
    expect(await (await app.request("/state", { headers: { Authorization: "Bearer runtime" } })).text()).toBe("state");
    expect(await (await app.request("/health")).text()).toBe("ok");
  });

  it("matches nested chat completions", async () => {
    const app = new Hono();
    app.all("/openrouter/*", (c) => c.text(c.req.path));
    const res = await app.request("http://127.0.0.1:8787/openrouter/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/openrouter/v1/chat/completions");
  });
});
