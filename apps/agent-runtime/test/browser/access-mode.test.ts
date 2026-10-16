import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ServicesSnapshot } from "@swarm/contracts";
import { browserTaskBlock, userRequestsBrowser } from "../../src/browser/access-mode";
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

  it("allows the browser when the person asked to sign in that way", () => {
    expect(userRequestsBrowser("Зайди в Pneumatic через браузер и закрой задачу")).toBe(true);
    expect(userRequestsBrowser("Please log in via the browser")).toBe(true);
    expect(userRequestsBrowser("Не через браузер, только API")).toBe(false);
    expect(userRequestsBrowser("Закрой задачу в Pneumatic")).toBe(false);
    expect(userRequestsBrowser("Если письмо отображается некорректно, откройте его в браузере")).toBe(false);
    expect(browserTaskBlock(api, { slug: "pneumatic", userAsked: true })).toBeNull();
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

  it("opens the browser when the person asked to sign in that way", async () => {
    let opened = false;
    const rt = {
      store: {
        getRun: async () => ({ id: "run_1", trigger: "chat", threadId: "chat_1", title: "зайди" }),
        readServices: async () => api,
        chats: {
          listMessages: async () => [
            { role: "user", runId: "run_1", text: "Зайди в Pneumatic через браузер", kind: "text" },
          ],
        },
      },
      step: async () => undefined,
      browser: {
        open: async () => {
          opened = true;
          return { id: "s1", meta: { liveUrl: null } };
        },
      },
    } as unknown as AgentRuntime;
    const app = new Hono();
    app.route("/", browserRoutes(rt));
    const res = await app.request("/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run_1", serviceSlug: "pneumatic", purpose: "войти как просит человек" }),
    });
    expect(res.status).toBe(200);
    expect(opened).toBe(true);
  });

  it("opens the browser when the email asks to sign in that way", async () => {
    let opened = false;
    const rt = {
      store: {
        getRun: async () => ({ id: "run_1", trigger: "email", threadId: "msg_1", title: "Задача" }),
        readServices: async () => api,
        listSteps: async () => [{ at: "t", kind: "email", text: "task от owner@example.com", data: { userBrowser: true } }],
      },
      step: async () => undefined,
      browser: {
        open: async () => {
          opened = true;
          return { id: "s1", meta: { liveUrl: null } };
        },
      },
    } as unknown as AgentRuntime;
    const app = new Hono();
    app.route("/", browserRoutes(rt));
    const res = await app.request("/browser/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run_1", serviceSlug: "pneumatic", purpose: "войти как просит письмо" }),
    });
    expect(res.status).toBe(200);
    expect(opened).toBe(true);
  });
});
