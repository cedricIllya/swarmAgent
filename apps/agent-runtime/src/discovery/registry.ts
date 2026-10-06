import { hostOf, rootDomain, sameBrand } from "../onboarding/domains";
import { warn } from "../core/log";
import { PROBE_TIMEOUT_MS, type McpFinding, type McpTransport } from "./types";

/** Официальный реестр MCP: удалённые серверы, чьё имя подтверждает владение доменом. */

interface RegistryServer {
  name?: string;
  title?: string;
  websiteUrl?: string;
  remotes?: Array<{ type?: string; url?: string }>;
}

export interface RegistryEntry {
  server?: RegistryServer;
  _meta?: { "io.modelcontextprotocol.registry/official"?: { status?: string; isLatest?: boolean } };
}

/** `app.linear/linear` → `linear.app`: имя в реестре — обратный DNS издателя. */
export function registryNameDomain(name: string | undefined): string | null {
  const ns = name?.split("/")[0];
  if (!ns || !ns.includes(".")) return null;
  const root = rootDomain(ns.split(".").reverse().join("."));
  // `io.github.<user>` — личный неймспейс GitHub, а не домен сервиса.
  return root === "github.io" ? null : root;
}

/** Удалённые MCP из реестра, которые принадлежат домену сервиса. */
export function matchRegistryServers(entries: RegistryEntry[], domain: string): McpFinding[] {
  const out: McpFinding[] = [];
  for (const e of entries) {
    const s = e.server;
    const meta = e._meta?.["io.modelcontextprotocol.registry/official"];
    if (!s?.remotes?.length) continue;
    if (meta && (meta.status !== undefined && meta.status !== "active")) continue;
    if (meta?.isLatest === false) continue;
    // Реестр проверяет владение доменом из имени, поэтому `com.notion/*` принадлежит Notion,
    // даже если приглашение пришло с `notion.so`.
    const nameDomain = registryNameDomain(s.name);
    const owned =
      (nameDomain !== null && sameBrand(nameDomain, domain)) ||
      (s.websiteUrl ? sameBrand(hostOf(s.websiteUrl), domain) : false) ||
      s.remotes.some((r) => r.url && sameBrand(hostOf(r.url), domain));
    if (!owned) continue;
    const sorted = [...s.remotes].sort((a, b) => Number(b.type === "streamable-http") - Number(a.type === "streamable-http"));
    for (const r of sorted) {
      if (!r.url || !/^https:\/\//i.test(r.url)) continue;
      const transport: McpTransport = r.type === "sse" ? "sse" : "streamable_http";
      if (out.some((f) => f.url === r.url)) continue;
      out.push({ url: r.url, transport, auth: "bearer", source: "registry", verified: false });
    }
  }
  return out;
}

export async function searchRegistry(
  query: string,
  domain: string,
  registryUrl: string,
  fetchImpl: typeof fetch,
): Promise<McpFinding[]> {
  try {
    const res = await fetchImpl(`${registryUrl}/v0/servers?search=${encodeURIComponent(query)}&limit=30`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { servers?: RegistryEntry[] };
    return matchRegistryServers(json.servers ?? [], domain);
  } catch (e) {
    warn("discovery", "реестр MCP недоступен", { error: String(e) });
    return [];
  }
}
