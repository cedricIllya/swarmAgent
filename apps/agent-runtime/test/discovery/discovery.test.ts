import { withoutForeignEndpoints } from "@swarm/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  composeRecipe,
  discoverService,
  htmlToText,
  interpretMcpResponse,
  matchRegistryServers,
  pickDocsSeed,
  probeMcp,
  rankDocLinks,
  registryNameDomain,
  scoreDocUrl,
  searchCovers,
} from "../../src/discovery";
import type { OpenRouterClient } from "../../src/llm/openrouter";

function res(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

const initOk = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "x" } } });

describe("interpretMcpResponse", () => {
  it("accepts a JSON-RPC initialize result as an open MCP", () => {
    expect(interpretMcpResponse(200, "application/json", "", initOk)).toEqual({ ok: true, auth: "none", status: 200 });
  });

  it("treats 401 as MCP that needs a token, OAuth when resource metadata is advertised", () => {
    expect(interpretMcpResponse(401, "", "Bearer realm=x", "")).toMatchObject({ ok: true, auth: "bearer" });
    expect(interpretMcpResponse(401, "application/json", "", '{"error":"unauthorized"}')).toMatchObject({ ok: true, auth: "bearer" });
    expect(
      interpretMcpResponse(401, "", 'Bearer resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource"', ""),
    ).toMatchObject({ ok: true, auth: "oauth" });
  });

  it("does not mistake a site's html login wall for an MCP", () => {
    expect(interpretMcpResponse(401, "text/html; charset=utf-8", "", "<html>login</html>").ok).toBe(false);
    expect(interpretMcpResponse(403, "text/html", "", "<html>blocked</html>").ok).toBe(false);
  });

  it("rejects html pages, 404 and empty 200s", () => {
    expect(interpretMcpResponse(200, "text/html", "", "<html>").ok).toBe(false);
    expect(interpretMcpResponse(404, "application/json", "", "{}").ok).toBe(false);
    expect(interpretMcpResponse(200, "application/json", "", '{"hello":1}').ok).toBe(false);
  });
});

describe("probeMcp", () => {
  it("follows one redirect with the same method and reports the final url", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe("POST");
      if (url === "https://acme.io/mcp") return res("", 308, { Location: "https://mcp.acme.io/mcp" });
      return res(initOk, 200, { "Content-Type": "application/json" });
    }) as unknown as typeof fetch;
    expect(await probeMcp("https://acme.io/mcp", "streamable_http", fetchImpl)).toMatchObject({ ok: true, auth: "none", url: "https://mcp.acme.io/mcp" });
  });

  it("gives up on redirect chains", async () => {
    const fetchImpl = vi.fn(async () => res("", 301, { Location: "https://elsewhere.io/" })) as unknown as typeof fetch;
    expect((await probeMcp("https://acme.io/mcp", "streamable_http", fetchImpl))?.ok).toBe(false);
  });
});

describe("registry matching", () => {
  it("reads the publisher domain from reverse-DNS names", () => {
    expect(registryNameDomain("app.linear/linear")).toBe("linear.app");
    expect(registryNameDomain("io.github.someone/linear-broker")).toBeNull();
    expect(registryNameDomain(undefined)).toBeNull();
  });

  it("keeps only remotes owned by the service domain, streamable_http first", () => {
    const entries = [
      {
        server: {
          name: "app.linear/linear",
          remotes: [
            { type: "sse", url: "https://mcp.linear.app/sse" },
            { type: "streamable-http", url: "https://mcp.linear.app/mcp" },
          ],
        },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
      },
      {
        server: { name: "io.github.evil/linear-broker", remotes: [{ type: "sse", url: "https://broker.vercel.app/api/mcp" }] },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
      },
      {
        server: { name: "app.linear/linear", remotes: [{ type: "streamable-http", url: "https://old.linear.app/mcp" }] },
        _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated", isLatest: false } },
      },
    ];
    const found = matchRegistryServers(entries, "linear.app");
    expect(found.map((f) => f.url)).toEqual(["https://mcp.linear.app/mcp", "https://mcp.linear.app/sse"]);
    expect(found[0]?.transport).toBe("streamable_http");
  });
});

describe("htmlToText", () => {
  it("strips markup, keeps the title and absolute links", () => {
    const { title, text } = htmlToText(
      '<html><head><title>Acme API</title><style>a{}</style></head><body><script>x()</script><h1>Auth</h1><p>Use <a href="https://acme.io/keys">keys</a> &amp; go</p></body></html>',
    );
    expect(title).toBe("Acme API");
    expect(text).toContain("Auth");
    expect(text).toContain("keys (https://acme.io/keys) & go");
    expect(text).not.toContain("x()");
  });
});

describe("composeRecipe", () => {
  it("prefers a verified MCP, then API, then browser", () => {
    const base = { slug: "acme", name: "Acme", domain: "acme.io", notes: "", agentId: "ag" };
    const mcp = { url: "https://mcp.acme.io/mcp", transport: "streamable_http" as const, auth: "bearer" as const, source: "registry" as const, verified: true };
    const api = { baseUrl: "https://api.acme.io/v1", docsUrl: "https://docs.acme.io", authHeader: "X-Api-Key", howToGetKey: "Settings" };
    const browser = { loginUrl: "https://acme.io/login", appUrl: "https://acme.io/" };

    expect(composeRecipe({ ...base, mcp, api, browser })).toMatchObject({ kind: "mcp", mcp: { url: mcp.url, auth: "bearer" }, api: { authHeader: "X-Api-Key" } });
    expect(composeRecipe({ ...base, mcp: { ...mcp, verified: false }, api, browser })).toMatchObject({ kind: "api", api: { baseUrl: api.baseUrl } });
    expect(composeRecipe({ ...base, mcp: null, api: null, browser })).toMatchObject({ kind: "browser" });
    expect(composeRecipe({ ...base, mcp: null, api: null, browser: null })).toBeNull();
  });
});

describe("discoverService", () => {
  it("finds a registry MCP, verifies it and marks the result confirmed", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/v0/servers")) {
        return res(
          JSON.stringify({
            servers: [
              {
                server: { name: "io.acme/acme", remotes: [{ type: "streamable-http", url: "https://mcp.acme.io/mcp" }] },
                _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
              },
            ],
          }),
          200,
          { "Content-Type": "application/json" },
        );
      }
      if (url === "https://mcp.acme.io/mcp" && init?.method === "POST") {
        return res("", 401, { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.acme.io/.well-known/oauth-protected-resource"' });
      }
      return res("not found", 404, { "Content-Type": "text/plain" });
    }) as unknown as typeof fetch;

    const steps: string[] = [];
    const result = await discoverService(
      { service: "Acme", domain: "acme.io", links: ["https://app.acme.io/invite/xyz"] },
      { fetchImpl, openRouter: null, model: "m", agentId: "ag_1", registryUrl: "https://registry.test", onStep: (t) => void steps.push(t) },
    );

    expect(result.domain).toBe("acme.io");
    expect(result.slug).toBe("acme");
    expect(result.mcp).toMatchObject({ url: "https://mcp.acme.io/mcp", auth: "oauth", verified: true, source: "registry" });
    expect(result.confirmed).toBe(true);
    expect(result.draftRecipe).toMatchObject({ kind: "mcp", domains: ["acme.io"], discoveredBy: "ag_1" });
    expect(result.browser?.loginUrl).toBe("https://app.acme.io/invite/xyz");
    expect(steps.some((s) => s.startsWith("MCP найден"))).toBe(true);
  });

  it("falls back to documentation and the model when no MCP answers", async () => {
    const docsHtml = "<html><head><title>Acme Developers</title></head><body>" + "<p>Base URL https://api.acme.io/v2. Create a token in Settings → API.</p>".repeat(20) + "</body></html>";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      if (url === "https://developers.acme.io/") return res(docsHtml, 200, { "Content-Type": "text/html" });
      return res("nope", 404, { "Content-Type": "text/html" });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const chat = vi.fn(async (_m: unknown, opts: { webSearch?: unknown }) => ({
      text: JSON.stringify(
        opts.webSearch
          ? { mcpUrl: null, mcpTransport: null, apiBaseUrl: null, apiDocsUrl: "https://developers.acme.io/", authHeader: null, howToGetKey: null, loginUrl: null, appUrl: null, notes: "" }
          : { mcpUrl: null, mcpTransport: null, apiBaseUrl: "https://api.acme.io/v2", apiDocsUrl: "https://developers.acme.io/", authHeader: "Authorization", howToGetKey: "Settings → API", loginUrl: "https://app.acme.io/login", appUrl: "https://app.acme.io", notes: "REST API v2" },
      ),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: opts.webSearch ? [{ url: "https://developers.acme.io/auth", title: "Auth", content: "tokens" }] : [],
    }));
    const openRouter = { chat } as unknown as OpenRouterClient;
    const usage: string[] = [];

    const result = await discoverService(
      { service: "Acme", domain: null, links: ["https://acme.io/invite/1", "https://click.sendgrid.net/x"] },
      { fetchImpl, openRouter, model: "m", agentId: "ag", registryUrl: "https://registry.test", onUsage: (a) => void usage.push(a) },
    );

    expect(result.domain).toBe("acme.io");
    expect(result.mcp).toBeNull();
    expect(result.confirmed).toBe(false);
    expect(result.api).toMatchObject({ baseUrl: "https://api.acme.io/v2", docsUrl: "https://developers.acme.io/", howToGetKey: "Settings → API" });
    expect(result.draftRecipe).toMatchObject({ kind: "api", api: { baseUrl: "https://api.acme.io/v2" }, browser: { loginUrl: "https://app.acme.io/login" } });
    expect(result.docs.map((d) => d.url)).toEqual(expect.arrayContaining(["https://developers.acme.io/", "https://developers.acme.io/auth"]));
    expect(usage).toEqual(["discover.search", "discover.extract"]);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).not.toContain("https://docs.acme.io/");
    expect(urls).not.toContain("https://acme.io/docs");
    expect(urls).not.toContain("https://developer.acme.io/");
  });

  it("does not treat another product's MCP docs as this service", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      if (url === "https://gensite.ru/api/mcp" && init?.method === "POST") {
        return res('{"error":"unauthorized"}', 401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      }
      return res("no", 404, { "Content-Type": "text/html" });
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        mcpUrl: "https://mcp.gitverse.ru",
        mcpTransport: "streamable_http",
        apiBaseUrl: "https://gitverse.ru/api",
        apiDocsUrl: "https://gitverse.ru/docs/ai/mcp/",
        authHeader: "Authorization",
        howToGetKey: "В разделе Управление токенами создайте API-токен",
        keyPageUrl: "https://gitverse.ru/login",
        readEndpoints: ["https://gitverse.ru/api/v1/repos"],
        loginUrl: "https://gitverse.ru/login",
        appUrl: "https://gitverse.ru/",
        notes: "GitVerse MCP требует Bearer токен. Endpoint: https://mcp.gitverse.ru.",
      }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [{ url: "https://gitverse.ru/docs/ai/mcp/", title: "GitVerse MCP", content: "endpoint https://mcp.gitverse.ru" }],
    }));

    const result = await discoverService(
      { service: "Gensite", domain: "gensite.ru", links: ["https://gensite.ru/register?invite=abc"] },
      { fetchImpl, openRouter: { chat } as unknown as OpenRouterClient, model: "m", agentId: "ag", registryUrl: "https://registry.test" },
    );

    const fetched = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(fetched.some((url) => url.includes("gitverse.ru"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("gitverse");
    expect(result.mcp).toMatchObject({ url: "https://gensite.ru/api/mcp", auth: "bearer", verified: true });
    expect(result.api).toBeNull();
    expect(result.browser).toMatchObject({ loginUrl: "https://gensite.ru/register?invite=abc", appUrl: "https://gensite.ru/" });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("skips search when a verified MCP needs no token", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/")) {
        return res(
          JSON.stringify({
            servers: [
              {
                server: { name: "io.acme/acme", remotes: [{ type: "streamable-http", url: "https://mcp.acme.io/mcp" }] },
                _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
              },
            ],
          }),
          200,
          { "Content-Type": "application/json" },
        );
      }
      if (url === "https://mcp.acme.io/mcp" && init?.method === "POST") return res(initOk, 200, { "Content-Type": "application/json" });
      return res("no", 404);
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    const chat = vi.fn();

    const result = await discoverService(
      { service: "Acme", domain: "acme.io", links: [] },
      { fetchImpl, openRouter: { chat } as unknown as OpenRouterClient, model: "m", agentId: "ag", registryUrl: "https://registry.test" },
    );

    expect(result.mcp).toMatchObject({ auth: "none", verified: true });
    expect(result.confirmed).toBe(true);
    expect(chat).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.map((call) => String(call[0])).some((url) => url.includes("llms.txt") || url.includes("developers."))).toBe(false);
  });

  it("does not fetch pages when search already returned the connection details", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      return res("no", 404);
    }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
    const chat = vi.fn(async () => ({
      text: JSON.stringify({
        mcpUrl: null,
        mcpTransport: null,
        apiBaseUrl: "https://api.acme.io/v1",
        apiDocsUrl: "https://docs.acme.io/api",
        authHeader: "Authorization: Bearer api_key",
        howToGetKey: "Settings → API",
        keyPageUrl: "https://acme.io/settings/api",
        readEndpoints: ["https://api.acme.io/v1/me", "https://api.acme.io/"],
        loginUrl: "https://acme.io/login",
        appUrl: "https://acme.io",
        notes: "REST",
      }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [{ url: "https://docs.acme.io/api", title: "API", content: "base https://api.acme.io/v1" }],
    }));
    const usage: string[] = [];

    const result = await discoverService(
      { service: "Acme", domain: "acme.io", links: ["https://acme.io/invite/1"] },
      { fetchImpl, openRouter: { chat } as unknown as OpenRouterClient, model: "m", agentId: "ag", registryUrl: "https://registry.test", onUsage: (a) => void usage.push(a) },
    );

    expect(usage).toEqual(["discover.search"]);
    expect(result.api).toMatchObject({
      baseUrl: "https://api.acme.io/v1",
      docsUrl: "https://docs.acme.io/api",
      howToGetKey: "Settings → API",
      authHeader: "Authorization",
      readEndpoints: ["https://api.acme.io/v1/me"],
    });
    expect(result.draftRecipe).toMatchObject({ kind: "api" });
    expect(fetchImpl.mock.calls.map((call) => String(call[0])).some((url) => url.includes("llms.txt") || url.includes("docs.acme.io"))).toBe(false);
  });

  it("reads llms.txt and one auth page instead of the rest of the site", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "POST") seen.push(url);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      if (url === "https://docs.acme.io/llms.txt") {
        return res(
          "# Acme\n- [Pricing](https://docs.acme.io/pricing): plans\n- [Auth](https://docs.acme.io/api/authentication): create a token in Settings → API\n- [Blog](https://docs.acme.io/blog): news\n",
          200,
          { "Content-Type": "text/plain" },
        );
      }
      if (url === "https://docs.acme.io/sitemap.xml") {
        return res("<urlset><loc>https://docs.acme.io/blog</loc></urlset>", 200, { "Content-Type": "application/xml" });
      }
      if (url === "https://docs.acme.io/api/authentication") {
        return res("<html><head><title>Auth</title></head><body><p>Base URL https://api.acme.io/v1. Token in Settings → API.</p></body></html>", 200, { "Content-Type": "text/html" });
      }
      if (url === "https://docs.acme.io/" || url === "https://docs.acme.io") {
        return res('<html><a href="/blog">Blog</a><a href="/pricing">Pricing</a><a href="/about">About</a></html>', 200, { "Content-Type": "text/html" });
      }
      return res("no", 404, { "Content-Type": "text/html" });
    }) as unknown as typeof fetch;
    const chat = vi.fn(async (_messages: unknown, opts: { webSearch?: unknown }) => ({
      text: JSON.stringify(
        opts.webSearch
          ? { mcpUrl: null, mcpTransport: null, apiBaseUrl: null, apiDocsUrl: "https://docs.acme.io/", authHeader: null, howToGetKey: null, loginUrl: null, appUrl: null, notes: "" }
          : { mcpUrl: null, mcpTransport: null, apiBaseUrl: "https://api.acme.io/v1", apiDocsUrl: "https://docs.acme.io/api/authentication", authHeader: "Authorization", howToGetKey: "Settings → API", loginUrl: null, appUrl: null, notes: "" },
      ),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [{ url: "https://docs.acme.io/", title: "Docs", content: "api" }],
    }));

    const result = await discoverService(
      { service: "Acme", domain: "acme.io", links: [] },
      { fetchImpl, openRouter: { chat } as unknown as OpenRouterClient, model: "m", agentId: "ag", registryUrl: "https://registry.test" },
    );

    expect(seen).toContain("https://docs.acme.io/llms.txt");
    expect(seen).toContain("https://docs.acme.io/api/authentication");
    expect(seen).not.toContain("https://docs.acme.io/");
    expect(seen).not.toContain("https://docs.acme.io/blog");
    expect(seen).not.toContain("https://docs.acme.io/pricing");
    expect(seen).not.toContain("https://docs.acme.io/about");
    expect(seen.some((url) => url.startsWith("https://developers."))).toBe(false);
    expect(result.api).toMatchObject({ baseUrl: "https://api.acme.io/v1", howToGetKey: "Settings → API" });
  });

  it("probes three documentation roots when search names nothing", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") !== "POST") seen.push(url);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      return res("no", 404, { "Content-Type": "text/html" });
    }) as unknown as typeof fetch;
    const chat = vi.fn(async () => ({
      text: JSON.stringify({ mcpUrl: null, mcpTransport: null, apiBaseUrl: null, apiDocsUrl: null, authHeader: null, howToGetKey: null, loginUrl: null, appUrl: null, notes: "" }),
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      model: "m",
      citations: [],
    }));

    await discoverService(
      { service: "Acme", domain: "acme.io", links: [] },
      { fetchImpl, openRouter: { chat } as unknown as OpenRouterClient, model: "m", agentId: "ag", registryUrl: "https://registry.test" },
    );

    expect(seen).toEqual(expect.arrayContaining(["https://docs.acme.io/", "https://developers.acme.io/", "https://acme.io/docs"]));
    for (const skipped of ["https://developer.acme.io/", "https://acme.io/developers", "https://acme.io/docs/api", "https://acme.io/api/docs", "https://api.acme.io/docs"]) {
      expect(seen).not.toContain(skipped);
    }
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("withoutForeignEndpoints", () => {
  it("drops GitVerse from a Gensite recipe", () => {
    const cleaned = withoutForeignEndpoints({
      slug: "gensite",
      name: "Gensite",
      kind: "mcp",
      domains: ["gensite.ru"],
      mcp: { url: "https://gensite.ru/api/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
      api: { baseUrl: "https://gitverse.ru/api", docsUrl: "https://gitverse.ru/docs/ai/mcp/", auth: "bearer", authHeader: "Authorization" },
      browser: { loginUrl: "https://gitverse.ru/login", appUrl: "https://gitverse.ru/" },
      notes:
        "GitVerse MCP требует Bearer. Endpoint: https://mcp.gitverse.ru. MCP: https://gensite.ru/api/mcp (проверен). Документация API: https://gitverse.ru/docs/ai/mcp/. Ключ: в разделе Управление токенами.",
      discoveredBy: null,
    });
    expect(cleaned.mcp?.url).toBe("https://gensite.ru/api/mcp");
    expect(cleaned.api).toBeUndefined();
    expect(cleaned.browser).toBeUndefined();
    expect(cleaned.notes).toBe("MCP: https://gensite.ru/api/mcp (проверен).");
    expect(cleaned.notes).not.toContain("gitverse");
  });

  it("снимает чужую страницу токена и оставляет кабинет своего домена", () => {
    const cleaned = withoutForeignEndpoints({
      slug: "gensite",
      name: "Gensite",
      kind: "mcp",
      domains: ["gensite.ru"],
      browser: {
        loginUrl: "https://gensite.ru/login",
        appUrl: "https://gensite.ru/",
        keyPageUrl: "https://gitverse.ru/settings/tokens",
      },
      notes: "Токен из кабинета.",
      discoveredBy: null,
    });
    expect(cleaned.browser?.loginUrl).toBe("https://gensite.ru/login");
    expect(cleaned.browser?.keyPageUrl).toBeUndefined();
    expect(cleaned.notes).toBe("Токен из кабинета.");
  });
});

describe("pickDocsSeed", () => {
  it("ignores a high-scoring MCP page on another domain", () => {
    expect(
      pickDocsSeed("gensite.ru", "https://gitverse.ru/docs/ai/mcp/", [
        "https://gitverse.ru/docs/ai/mcp/",
        "https://gensite.ru/docs/mcp",
      ]),
    ).toBe("https://gensite.ru/docs/mcp");
    expect(pickDocsSeed("gensite.ru", null, ["https://gitverse.ru/docs/ai/mcp/"])).toBeNull();
  });
});

describe("doc link ranking", () => {
  it("prefers an API or auth page over the rest of the site", () => {
    expect(scoreDocUrl("https://docs.acme.io/openapi.json")).toBeGreaterThan(scoreDocUrl("https://docs.acme.io/api/authentication"));
    expect(scoreDocUrl("https://docs.acme.io/blog")).toBe(0);
    expect(scoreDocUrl("https://docs.acme.io/logo.png")).toBe(0);
    expect(
      rankDocLinks(
        ["https://docs.acme.io/blog", "https://docs.acme.io/pricing", "https://docs.acme.io/api/authentication", "https://cdn.example/logo.png"],
        "acme.io",
        "docs.acme.io",
        new Set(["https://docs.acme.io/"]),
      ),
    ).toEqual(["https://docs.acme.io/api/authentication"]);
  });

  it("treats search as complete only when the docs URL is one of the citations", () => {
    const findings = {
      mcpUrl: null,
      mcpTransport: null,
      apiBaseUrl: "https://api.acme.io/v1",
      apiDocsUrl: "https://docs.acme.io/api",
      authHeader: "Authorization",
      howToGetKey: "Settings → API",
      loginUrl: null,
      appUrl: null,
      notes: "",
      keyPageUrl: null,
      readEndpoints: ["https://api.acme.io/v1/me"],
    };
    expect(searchCovers(findings, [{ url: "https://docs.acme.io/api", title: "API", content: "" }])).toBe(true);
    expect(searchCovers(findings, [{ url: "https://example.com/unrelated", title: "", content: "" }])).toBe(false);
    expect(searchCovers({ ...findings, howToGetKey: null }, [{ url: "https://docs.acme.io/api", title: "API", content: "" }])).toBe(false);
    expect(searchCovers({ ...findings, readEndpoints: [] }, [{ url: "https://docs.acme.io/api", title: "API", content: "" }])).toBe(false);
    expect(searchCovers({ ...findings, readEndpoints: ["https://api.acme.io/"] }, [{ url: "https://docs.acme.io/api", title: "API", content: "" }])).toBe(false);
  });
});
