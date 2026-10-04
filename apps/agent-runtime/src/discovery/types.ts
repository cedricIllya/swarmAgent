import type { ServiceRecipe } from "@swarm/contracts";
import type { ChatResult, OpenRouterClient } from "../openrouter";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
export const PROBE_TIMEOUT_MS = 6_000;

export type McpTransport = "streamable_http" | "sse";
export type McpAuth = "none" | "bearer" | "oauth";

export interface McpFinding {
  url: string;
  transport: McpTransport;
  auth: McpAuth;
  source: "registry" | "well-known" | "docs";
  /** Сервер ответил на `initialize` (или 401 с MCP-заголовками). */
  verified: boolean;
}

export interface ApiFinding {
  baseUrl: string | null;
  docsUrl: string | null;
  authHeader: string;
  howToGetKey: string;
}

export interface DocFinding {
  url: string;
  title: string;
  excerpt: string;
}

export interface DiscoveryInput {
  service: string | null;
  domain: string | null;
  links: string[];
}

export interface DiscoveryResult {
  service: string;
  slug: string;
  domain: string | null;
  mcp: McpFinding | null;
  api: ApiFinding | null;
  browser: { loginUrl: string; appUrl: string } | null;
  docs: DocFinding[];
  notes: string;
  draftRecipe: ServiceRecipe | null;
  /** MCP подтверждён runtime и принадлежит домену сервиса: рецепт можно записать без агента. */
  confirmed: boolean;
}

export interface DiscoveryDeps {
  fetchImpl?: typeof fetch;
  /** Нет клиента — работаем только реестром и пробами, без поиска и чтения документации. */
  openRouter: OpenRouterClient | null;
  model: string;
  agentId: string;
  registryUrl?: string;
  onStep?: (text: string, data?: Record<string, unknown>) => Promise<void> | void;
  onUsage?: (action: string, r: ChatResult) => Promise<void> | void;
}
