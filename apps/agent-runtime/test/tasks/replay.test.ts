import { describe, expect, it, vi } from "vitest";
import type { Run, ServiceCredential, ServiceRecipe, ServicesSnapshot } from "@swarm/contracts";
import { pageDigest, savedTasksCall } from "../../src/tasks/watch-page";
import { rememberWatch, surveySavedCalls } from "../../src/tasks/replay";

const run = { id: "run_1", title: "Плановая проверка сервисов", status: "running" } as Run;

const recipe: ServiceRecipe = {
  slug: "linear",
  name: "Linear",
  kind: "api",
  domains: ["linear.app"],
  notes: "",
  discoveredBy: null,
  watchesTasks: true,
  api: { baseUrl: "https://api.linear.app", auth: "bearer", authHeader: "Authorization" },
};

function cred(extra: Partial<ServiceCredential> = {}): ServiceCredential {
  return { slug: "linear", kind: "api", token: "lin_secret_value", ...extra };
}

function snap(credential: ServiceCredential, recipeOverride: ServiceRecipe = recipe): ServicesSnapshot {
  return { generatedAt: "t", recipes: [recipeOverride], credentials: [credential] };
}

describe("savedTasksCall", () => {
  it("rejects a foreign url and a url that contains the token", () => {
    expect(savedTasksCall(recipe, cred({ tasksCall: { kind: "api", method: "GET", url: "https://evil.example/issues" } }))).toBeNull();
    expect(
      savedTasksCall(recipe, cred({ tasksCall: { kind: "api", method: "GET", url: "https://api.linear.app/issues?token=lin_secret_value" } })),
    ).toBeNull();
    expect(savedTasksCall(recipe, cred({ tasksCall: { kind: "api", method: "GET", url: "https://api.linear.app/issues?assignee=me" } }))?.url).toBe(
      "https://api.linear.app/issues?assignee=me",
    );
  });
});

describe("surveySavedCalls", () => {
  it("does not call the model when the response is unchanged", async () => {
    const body = '{"issues":[{"title":"Fix","updatedAt":"2026-10-07T10:00:00Z"}]}';
    const later = '{"issues":[{"title":"Fix","updatedAt":"2026-10-07T18:22:00Z"}]}';
    const chat = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(later, { status: 200, headers: { "content-type": "application/json" } }));
    const rt = {
      isCanceled: async () => false,
      store: { readServices: async () => snap(cred({ tasksCall: { kind: "api", method: "GET", url: "https://api.linear.app/issues" }, tasksDigest: pageDigest(body) })) },
      openRouter: { chat },
      step: vi.fn(async () => undefined),
      services: { applyReport: vi.fn() },
    };
    const result = await surveySavedCalls(rt as never, run, fetchImpl as never);
    expect(result.tasks).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("parses a changed response once and remembers the digest", async () => {
    const credential = cred({ tasksCall: { kind: "api", method: "GET", url: "https://api.linear.app/issues" }, tasksDigest: "a".repeat(64) });
    const services = snap(credential);
    const chat = vi.fn(async () => ({
      text: JSON.stringify({ tasks: [{ title: "Починить", detail: "LIN-1", key: "LIN-1" }] }),
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
    }));
    const fetchImpl = vi.fn(async () => new Response('{"issues":["new"]}', { status: 200 }));
    const applyReport = vi.fn(async (input: { credential: ServiceCredential }) => {
      services.credentials = [input.credential];
    });
    const rt = {
      isCanceled: async () => false,
      model: "m",
      taskRef: () => ({ taskId: run.id, taskTitle: run.title }),
      store: { readServices: async () => services, addUsage: vi.fn(async () => undefined) },
      openRouter: { chat },
      step: vi.fn(async () => undefined),
      services: { applyReport },
    };
    const result = await surveySavedCalls(rt as never, run, fetchImpl as never);
    expect(result.tasks.map((task) => task.title)).toEqual(["Починить"]);
    expect(chat).toHaveBeenCalledOnce();
    expect(applyReport).toHaveBeenCalledOnce();
    expect(services.credentials[0]?.tasksDigest).toBe(pageDigest('{"issues":["new"]}'));
  });
});

describe("rememberWatch", () => {
  it("stores an MCP tool once and does not replace it", async () => {
    const mcp: ServiceRecipe = {
      ...recipe,
      kind: "mcp",
      mcp: { url: "https://mcp.linear.app/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
    };
    const credential = cred({ kind: "mcp" });
    const services = snap(credential, mcp);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { method?: string };
      if (payload.method === "initialize") {
        return new Response("{}", { status: 200, headers: { "mcp-session-id": "s1", "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "LIN-9 Починить" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    const applyReport = vi.fn(async (input: { credential: ServiceCredential }) => {
      services.credentials = [input.credential];
    });
    const rt = {
      isCanceled: async () => false,
      model: "m",
      taskRef: () => ({ taskId: run.id, taskTitle: run.title }),
      store: { readServices: async () => services, addUsage: vi.fn(async () => undefined) },
      openRouter: {
        chat: vi.fn(async () => ({
          text: JSON.stringify({ tasks: [{ title: "Починить", detail: "", key: "LIN-9" }] }),
          model: "m",
          promptTokens: 1,
          completionTokens: 1,
          costUsd: 0,
        })),
      },
      step: vi.fn(async () => undefined),
      services: { applyReport },
    };
    try {
      const first = await rememberWatch(rt as never, run, { service: "linear", tool: "mcp_linear_list_issues", arguments: {} });
      expect(first).toMatchObject({ ok: true, saved: true });
      expect(services.credentials[0]?.tasksCall).toMatchObject({ kind: "mcp", tool: "list_issues" });
      const again = await rememberWatch(rt as never, run, { service: "linear", tool: "other_tool" });
      expect(again).toMatchObject({ ok: true, saved: false, tasks: [] });
      expect(services.credentials[0]?.tasksCall?.tool).toBe("list_issues");
    } finally {
      globalThis.fetch = previous;
    }
  });
});
