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
    expect(doc.mcp_servers["skyvern"]).toBeDefined();
    expect(doc.mcp_servers["linear"]?.url).toBe("https://mcp.linear.app/mcp");
    expect(doc.mcp_servers["linear"]?.headers?.["Authorization"]).toBe("Bearer lin_xxx");
    expect(doc.mcp_servers["linear"]).not.toHaveProperty("transport");
    expect(doc.mcp_servers["linear"]).not.toHaveProperty("include_tools");
    expect((doc.mcp_servers["linear"] as { tools?: { include?: string[] } }).tools?.include).toEqual(["list_issues"]);
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
    const withRecipe = renderAllFiles({
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
      serviceSkills: [{ slug: "gensite", content: "https://gensite.ru/api/mcp {{AGENT_EMAIL}}" }],
    });
    const gensite = withRecipe.find((f) => f.path === "skills/gensite/SKILL.md")?.content ?? "";
    expect(gensite).toContain("gensite.ru/api/mcp");
    expect(gensite).toContain("ops@agents.test");
    expect(gensite).not.toContain("{{AGENT_EMAIL}}");
  });
});
