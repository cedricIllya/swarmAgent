import { describe, expect, it, vi } from "vitest";
import {
  composeRecipe,
  discoverService,
  htmlToText,
  interpretMcpResponse,
  matchRegistryServers,
  probeMcp,
  registryNameDomain,
} from "./discovery";
import type { OpenRouterClient } from "./openrouter";

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
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://registry.test/")) return res(JSON.stringify({ servers: [] }), 200, { "Content-Type": "application/json" });
      if (url === "https://developers.acme.io/") return res(docsHtml, 200, { "Content-Type": "text/html" });
      return res("nope", 404, { "Content-Type": "text/html" });
    }) as unknown as typeof fetch;

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
  });
});
