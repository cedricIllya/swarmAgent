import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderConfigYaml } from "./index";

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
            mcp: { url: "https://mcp.linear.app/mcp", transport: "streamable_http", auth: "bearer", includeTools: [] },
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
  });
});
