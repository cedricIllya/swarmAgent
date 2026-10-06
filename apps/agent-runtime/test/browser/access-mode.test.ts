import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServicesSnapshot } from "@swarm/contracts";
import { browserTaskBlock } from "../../src/browser/access-mode";
import { browserRoutes } from "../../src/http/browser-routes";
import type { AgentRuntime } from "../../src/runtime";

const api: ServicesSnapshot = {
  generatedAt: "t",
  recipes: [
    {
      slug: "pneumatic",
      name: "Pneumatic",
      kind: "api",
      domains: ["pneumatic.app"],
      api: { baseUrl: "https://api.pneumatic.app", auth: "bearer", authHeader: "Authorization" },
      browser: { loginUrl: "https://my.pneumatic.app/", appUrl: "https://my.pneumatic.app/" },
      notes: "",
      discoveredBy: null,
    },
  ],
  credentials: [{ slug: "pneumatic", kind: "api", token: "key", password: "pw" }],
};

describe("browserTaskBlock", () => {
  it("keeps an API-connected service on the API", () => {
    expect(browserTaskBlock(api, { slug: "pneumatic" })).toMatch(/через API/);
    expect(browserTaskBlock(api, { url: "https://my.pneumatic.app/workflows" })).toMatch(/api\.pneumatic\.app/);
  });

  it("allows the browser until the API key exists", () => {
    const pending: ServicesSnapshot = {
      ...api,
      credentials: [{ slug: "pneumatic", kind: "api", password: "pw" }],
    };
    expect(browserTaskBlock(pending, { slug: "pneumatic" })).toBeNull();
  });

  it("allows the browser when that is the service method", () => {
    const browser: ServicesSnapshot = {
      ...api,
      recipes: [{ ...api.recipes[0]!, kind: "browser" }],
      credentials: [{ slug: "pneumatic", kind: "browser", password: "pw" }],
    };
    expect(browserTaskBlock(browser, { slug: "pneumatic" })).toBeNull();
  });

  it("keeps MCP on its tools", () => {
    const mcp: ServicesSnapshot = {
      generatedAt: "t",
      recipes: [
        {
          slug: "linear",
          name: "Linear",
          kind: "mcp",
          domains: ["linear.app"],
          mcp: { url: "https://mcp.linear.app/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
          notes: "",
          discoveredBy: null,
        },
      ],
      credentials: [{ slug: "linear", kind: "mcp", token: "lin" }],
    };
    expect(browserTaskBlock(mcp, { slug: "linear" })).toMatch(/mcp_linear_/);
  });
});

describe("POST /browser/open", () => {
  it("refuses the browser for a service connected by API", async () => {
    let opened = false;
    const rt = {
      store: {
        getRun: async () => ({ id: "run_1" }),
        readServices: async () => api,
      },
      step: async () => undefined,
      browser: {
        open: async () => {
          opened = true;
          throw new Error("browser opened");
        },
      },
    } as unknown as AgentRuntime;
    const app = new Hono();
    app.route("/", browserRoutes(rt));
    const res = await app.request("/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run_1", serviceSlug: "pneumatic", purpose: "закрыть задачу" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/через API/) });
    expect(opened).toBe(false);
  });
});
