import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderAllFiles, renderConfigYaml, replaceMcpServers } from "./index";

describe("renderConfigYaml", () => {
  it("puts openrouter model and mcp servers with tenant token", () => {
    const yaml = renderConfigYaml({
      agentId: "agt_1",
      agentName: "Ops",
      email: "ops@agents.test",
      model: "anthropic/claude-sonnet-4",
      autonomous: false,
      skyvern: { enabled: true },
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "linear",
            name: "Linear",
            kind: "mcp",
            domains: ["linear.app"],
            mcp: {
              url: "https://mcp.linear.app/mcp",
              transport: "streamable_http",
              auth: "bearer",
              includeTools: ["list_issues"],
            },
            notes: "",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "linear", kind: "mcp", token: "lin_xxx" }],
      },
    });
    const doc = parse(yaml) as {
      model: { provider: string; default: string };
      mcp_servers: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(doc.model.provider).toBe("openrouter");
    expect(doc.model.default).toBe("anthropic/claude-sonnet-4");
    expect(doc.mcp_servers["skyvern"]).toBeUndefined();
    expect(doc.mcp_servers["linear"]?.url).toBe("https://mcp.linear.app/mcp");
    expect(doc.mcp_servers["linear"]?.headers?.["Authorization"]).toBe("Bearer lin_xxx");
    expect(doc.mcp_servers["linear"]).not.toHaveProperty("transport");
    expect(doc.mcp_servers["linear"]).not.toHaveProperty("include_tools");
    expect((doc.mcp_servers["linear"] as { tools?: { include?: string[] } }).tools?.include).toEqual(["list_issues"]);
  });

  it("не подключает MCP с авторизацией, пока токена нет; без авторизации — подключает", () => {
    const yaml = renderConfigYaml({
      agentId: "agt_1",
      agentName: "Ops",
      email: "ops@agents.test",
      model: "m",
      autonomous: false,
      skyvern: { enabled: false },
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "trello",
            name: "Trello",
            kind: "mcp",
            domains: ["trello.com"],
            mcp: { url: "https://mcp.trello.com/v1", transport: "streamable_http", auth: "bearer", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
          {
            slug: "open",
            name: "Open",
            kind: "mcp",
            domains: ["open.test"],
            mcp: { url: "https://open.test/mcp", transport: "streamable_http", auth: "none", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "trello", kind: "browser", password: "pw" }],
      },
    });
    const doc = parse(yaml) as { mcp_servers: Record<string, unknown>; approvals: Record<string, string> };
    expect(doc.mcp_servers["trello"]).toBeUndefined();
    expect(doc.mcp_servers["open"]).toEqual({ url: "https://open.test/mcp" });
    expect(doc.approvals).toEqual({ mode: "off", unattended_mode: "approve", cron_mode: "approve" });
    // Для YAML 1.1 (PyYAML в Hermes) голое off — булево. Кавычки должны пережить и перезапись mcp_servers.
    expect(yaml).toContain('mode: "off"');
    const rewritten = replaceMcpServers(yaml, { generatedAt: "t2", recipes: [], credentials: [] }, false);
    expect(rewritten).toContain('mode: "off"');
  });

  it("не кладёт в Hermes ключ, записанный до проверки, и OAuth без access token", () => {
    const yaml = renderConfigYaml({
      agentId: "agt_1",
      agentName: "Ops",
      email: "ops@agents.test",
      model: "m",
      autonomous: false,
      skyvern: { enabled: false },
      services: {
        generatedAt: "t",
        recipes: [
          {
            slug: "trello",
            name: "Trello",
            kind: "mcp",
            domains: ["trello.com"],
            mcp: { url: "https://mcp.trello.com/v1", transport: "streamable_http", auth: "bearer", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
          {
            slug: "oauth",
            name: "Oauth",
            kind: "mcp",
            domains: ["oauth.test"],
            mcp: { url: "https://oauth.test/mcp", transport: "streamable_http", auth: "oauth", includeTools: [] },
            notes: "",
            discoveredBy: null,
          },
        ],
        credentials: [
          { slug: "trello", kind: "browser", token: "trello-api-token-value", password: "pw" },
          { slug: "oauth", kind: "api", token: "rest-token-value", oauth: { accessToken: "oa_1" } },
        ],
      },
    });
    const doc = parse(yaml) as {
      mcp_servers: Record<string, { url?: string; headers?: Record<string, string> } | undefined>;
    };
    expect(doc.mcp_servers["trello"]).toBeUndefined();
    expect(doc.mcp_servers["oauth"]?.headers?.["Authorization"]).toBe("Bearer oa_1");
  });

  it("replaces only mcp_servers and keeps the rest of config.yaml", () => {
    const original = renderConfigYaml({
      agentId: "agt_1",
      agentName: "Ops",
      email: "ops@agents.test",
      model: "anthropic/claude-sonnet-4",
      autonomous: false,
      skyvern: { enabled: false },
      services: { generatedAt: "t", recipes: [], credentials: [] },
    });
    const next = replaceMcpServers(
      original,
      {
        generatedAt: "t2",
        recipes: [
          {
            slug: "gensite",
            name: "Gensite",
            kind: "mcp",
            domains: ["gensite.app"],
            mcp: { url: "https://mcp.gensite.app/mcp", transport: "sse", auth: "bearer", includeTools: [] },
            notes: "заметка не должна стать description",
            discoveredBy: null,
          },
        ],
        credentials: [{ slug: "gensite", kind: "mcp", token: "gs_1" }],
      },
      false,
    );
    const doc = parse(next) as {
      model: { default: string };
      mcp_servers: Record<string, { url?: string; transport?: string; description?: string; headers?: Record<string, string> }>;
    };
    expect(doc.model.default).toBe("anthropic/claude-sonnet-4");
    expect(doc.mcp_servers["gensite"]?.url).toBe("https://mcp.gensite.app/mcp");
    expect(doc.mcp_servers["gensite"]?.transport).toBe("sse");
    expect(doc.mcp_servers["gensite"]?.headers?.["Authorization"]).toBe("Bearer gs_1");
    expect(doc.mcp_servers["gensite"]).not.toHaveProperty("description");
  });

  it("writes shared files as 0644 so the hermes container can read them", () => {
    const files = renderAllFiles({
      config: {
        agentId: "agt_1",
        agentName: "Ops",
        email: "ops@agents.test",
        model: "m",
        autonomous: false,
        skyvern: { enabled: false },
        services: { generatedAt: "t", recipes: [], credentials: [] },
      },
      env: { openRouterApiKey: "k", runtimeToken: "t" },
      skillTemplate: "hi",
    });
    for (const file of files) expect(file.mode).toBe("0644");
    expect(files.filter((f) => f.path.startsWith("skills/")).map((f) => f.path)).toEqual([
      "skills/swarm-worker/SKILL.md",
    ]);
  });
});
