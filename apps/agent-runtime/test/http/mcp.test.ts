import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mcpRoutes } from "../../src/http/mcp";
import type { AgentRuntime } from "../../src/runtime";

function appFor(paths: Record<string, { status: number; body: unknown }>) {
  const seen: string[] = [];
  const rt = { cfg: { port: 8787, runtimeToken: "rt" } } as AgentRuntime;
  const dispatch = async (req: Request) => {
    seen.push(new URL(req.url).pathname);
    expect(req.headers.get("authorization")).toBe("Bearer rt");
    const hit = paths[new URL(req.url).pathname];
    return new Response(JSON.stringify(hit?.body ?? { error: "missing" }), { status: hit?.status ?? 404 });
  };
  const app = new Hono();
  app.route("/", mcpRoutes(rt, dispatch));
  return { app, seen };
}

describe("POST /mcp", () => {
  it("lists runtime tools and forwards a call without curl", async () => {
    const { app, seen } = appFor({ "/browser/goal": { status: 200, body: { done: true, steps: 2 } } });
    const listed = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.map((tool) => tool.name)).toContain("browser_goal");

    const called = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_goal", arguments: { sessionId: "s", instruction: "открой задачи" } },
      }),
    });
    const body = (await called.json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]?.text).toContain('"done":true');
    expect(seen).toEqual(["/browser/goal"]);
  });

  it("answers initialize and ignores notifications", async () => {
    const { app } = appFor({});
    const init = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(init.headers.get("mcp-session-id")).toBe("swarm");
    expect(init.status).toBe(200);
    const note = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
  });
});
