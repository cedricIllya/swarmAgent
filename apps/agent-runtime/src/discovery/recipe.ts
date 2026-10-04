import type { ServiceRecipe } from "@swarm/contracts";
import { hostOf, rootDomain, sameBrand } from "../domains";
import { httpsUrl } from "./http";
import type { ApiFinding, McpFinding } from "./types";

export function belongsTo(url: string, domain: string | null): boolean {
  return domain !== null && sameBrand(hostOf(url), domain);
}

/** Черновик рецепта из находок: MCP, если подтверждён; иначе API; иначе браузер. */
export function composeRecipe(args: {
  slug: string;
  name: string;
  domain: string | null;
  mcp: McpFinding | null;
  api: ApiFinding | null;
  browser: { loginUrl: string; appUrl: string } | null;
  notes: string;
  agentId: string;
}): ServiceRecipe | null {
  const domains = args.domain ? [args.domain] : [];
  // Хост MCP того же бренда (`mcp.notion.com` при `notion.so`) — тоже домен сервиса для будущих писем.
  const mcpRoot = args.mcp?.verified ? rootDomain(hostOf(args.mcp.url)) : "";
  if (mcpRoot && args.domain && mcpRoot !== args.domain && sameBrand(mcpRoot, args.domain)) domains.push(mcpRoot);
  const base = { slug: args.slug, name: args.name, domains, notes: args.notes, discoveredBy: args.agentId };
  const api =
    args.api?.baseUrl && httpsUrl(args.api.baseUrl)
      ? {
          baseUrl: httpsUrl(args.api.baseUrl)!,
          ...(httpsUrl(args.api.docsUrl) ? { docsUrl: httpsUrl(args.api.docsUrl)! } : {}),
          auth: "bearer" as const,
          authHeader: args.api.authHeader || "Authorization",
        }
      : undefined;
  const browser =
    args.browser && httpsUrl(args.browser.loginUrl) && httpsUrl(args.browser.appUrl)
      ? { loginUrl: httpsUrl(args.browser.loginUrl)!, appUrl: httpsUrl(args.browser.appUrl)! }
      : undefined;

  if (args.mcp?.verified) {
    return {
      ...base,
      kind: "mcp",
      mcp: { url: args.mcp.url, transport: args.mcp.transport, auth: args.mcp.auth, includeTools: [] },
      ...(api ? { api } : {}),
      ...(browser ? { browser } : {}),
    };
  }
  if (api) return { ...base, kind: "api", api, ...(browser ? { browser } : {}) };
  if (browser) return { ...base, kind: "browser", browser };
  return null;
}
