import { discardBody, readHead } from "./http";
import { PROBE_TIMEOUT_MS, type McpAuth, type McpFinding, type McpTransport } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpProbe {
  ok: boolean;
  auth: McpAuth;
  status: number;
  /** Адрес, который реально ответил (после редиректа может отличаться от запрошенного). */
  url?: string;
}

/** Разбор ответа сервера на `initialize`: это MCP или нет, и нужен ли токен. */
export function interpretMcpResponse(status: number, contentType: string, wwwAuthenticate: string, body: string): McpProbe {
  const isJson = /application\/json/i.test(contentType);
  const isSse = /text\/event-stream/i.test(contentType);
  if (status === 401 || status === 403) {
    // Страница логина сайта тоже отдаёт 401, но HTML-ом и без WWW-Authenticate. MCP отвечает JSON-ом или заголовком Bearer.
    if (!wwwAuthenticate && !isJson && !isSse) return { ok: false, auth: "none", status };
    const oauth = /resource_metadata|authorization_uri|oauth/i.test(wwwAuthenticate) || /oauth/i.test(body);
    return { ok: true, auth: oauth ? "oauth" : "bearer", status };
  }
  if (status >= 200 && status < 300) {
    if (isSse) return { ok: /"jsonrpc"|protocolVersion|event:/.test(body), auth: "none", status };
    if (isJson) {
      try {
        const json = JSON.parse(body) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
        return { ok: json.jsonrpc === "2.0" && (json.result !== undefined || json.error !== undefined), auth: "none", status };
      } catch {
        return { ok: false, auth: "none", status };
      }
    }
    return { ok: false, auth: "none", status };
  }
  // 400/406 с JSON-RPC-ошибкой — сервер MCP есть, просто не понравился наш запрос.
  if ((status === 400 || status === 406) && /"jsonrpc"/.test(body)) return { ok: true, auth: "none", status };
  return { ok: false, auth: "none", status };
}

/**
 * Один `initialize` без автоследования редиректам: fetch превращал бы POST в GET и
 * страница логина сайта выглядела бы как MCP с 401. Один редирект повторяем тем же методом.
 */
export async function probeMcp(url: string, transport: McpTransport, fetchImpl: typeof fetch, hop = 0): Promise<McpProbe | null> {
  try {
    const res =
      transport === "sse"
        ? await fetchImpl(url, {
            method: "GET",
            headers: { Accept: "text/event-stream" },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            redirect: "manual",
          })
        : await fetchImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": PROTOCOL_VERSION,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "swarm-agent", version: "0.1.0" },
              },
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
            redirect: "manual",
          });
    if (res.status >= 300 && res.status < 400) {
      discardBody(res);
      const location = res.headers.get("location");
      if (!location || hop >= 1) return { ok: false, auth: "none", status: res.status };
      return probeMcp(new URL(location, url).toString(), transport, fetchImpl, hop + 1);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (transport === "sse" && res.ok) {
      discardBody(res);
      return { ok: /text\/event-stream/i.test(contentType), auth: "none", status: res.status, url };
    }
    const body = await readHead(res, 20_000);
    return { ...interpretMcpResponse(res.status, contentType, res.headers.get("www-authenticate") ?? "", body), url };
  } catch {
    return null;
  }
}

export function wellKnownMcpUrls(domain: string): Array<{ url: string; transport: McpTransport }> {
  return [
    { url: `https://mcp.${domain}/mcp`, transport: "streamable_http" },
    { url: `https://mcp.${domain}/`, transport: "streamable_http" },
    { url: `https://${domain}/mcp`, transport: "streamable_http" },
    { url: `https://${domain}/api/mcp`, transport: "streamable_http" },
    { url: `https://api.${domain}/mcp`, transport: "streamable_http" },
    { url: `https://mcp.${domain}/sse`, transport: "sse" },
  ];
}

/** Первый подтверждённый MCP из списка кандидатов; остальные пробы не ждём. */
export async function verifyCandidates(candidates: McpFinding[], fetchImpl: typeof fetch): Promise<McpFinding | null> {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  const probes = await Promise.all(unique.map(async (c) => ({ c, p: await probeMcp(c.url, c.transport, fetchImpl) })));
  const hits = probes.filter((x) => x.p?.ok);
  // Реестр и документация точнее слепых проб; среди равных — streamable_http.
  const rank = (f: McpFinding) => (f.source === "registry" ? 0 : f.source === "docs" ? 1 : 2) * 2 + (f.transport === "sse" ? 1 : 0);
  hits.sort((a, b) => rank(a.c) - rank(b.c));
  const best = hits[0];
  if (!best?.p) return null;
  return { ...best.c, url: best.p.url ?? best.c.url, auth: best.p.auth, verified: true };
}
