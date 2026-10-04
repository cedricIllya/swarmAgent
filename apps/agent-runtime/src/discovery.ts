import type { ServiceRecipe } from "@swarm/contracts";
import { hostOf, isNoiseDomain, pickServiceDomain, rootDomain, sameBrand, slugFor } from "./domains";
import type { ChatResult, OpenRouterClient, WebCitation } from "./openrouter";
import { warn } from "./log";

/**
 * Поиск способа входа в сервис, которого нет в общем каталоге:
 * официальный реестр MCP → типовые адреса MCP на домене → поиск документации
 * в интернете → чтение найденных страниц. Каждый найденный MCP проверяется
 * настоящим `initialize`, поэтому рецепт `kind: mcp` можно записывать сразу.
 */

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const PROTOCOL_VERSION = "2025-06-18";
const PROBE_TIMEOUT_MS = 6_000;
const PAGE_LIMIT_BYTES = 400_000;
const PAGE_TEXT_CHARS = 9_000;

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

// --- Проверка MCP -----------------------------------------------------------

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

async function readHead(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < maxBytes) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 2_500)),
      ]);
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return out;
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

function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

// --- Реестр MCP -------------------------------------------------------------

interface RegistryServer {
  name?: string;
  title?: string;
  websiteUrl?: string;
  remotes?: Array<{ type?: string; url?: string }>;
}

interface RegistryEntry {
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

async function searchRegistry(
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

// --- Типовые адреса на домене ------------------------------------------------

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

export function likelyDocsUrls(domain: string): string[] {
  return [
    `https://developers.${domain}/`,
    `https://developer.${domain}/`,
    `https://docs.${domain}/`,
    `https://${domain}/developers`,
    `https://${domain}/docs/api`,
    `https://${domain}/api/docs`,
    `https://${domain}/docs`,
    `https://api.${domain}/docs`,
  ];
}

// --- Чтение страниц ----------------------------------------------------------

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|pre|section|article|header|footer|table)[^>]*>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) =>
      /^https?:\/\//i.test(href) ? `${inner} (${href})` : inner,
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
}

export async function fetchPage(url: string, fetchImpl: typeof fetch, maxChars = PAGE_TEXT_CHARS): Promise<FetchedPage | null> {
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "User-Agent": "Mozilla/5.0 (compatible; SwarmAgent/0.1; +https://swarm-agent.local)",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      discardBody(res);
      return { url, finalUrl: res.url || url, status: res.status, title: "", text: "" };
    }
    const raw = await readHead(res, PAGE_LIMIT_BYTES);
    const page = /html/i.test(contentType) ? htmlToText(raw) : { title: "", text: raw.replace(/\s+/g, " ").trim() };
    return { url, finalUrl: res.url || url, status: res.status, title: page.title, text: page.text.slice(0, maxChars) };
  } catch {
    return null;
  }
}

// --- Модель: поиск и извлечение ---------------------------------------------

const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mcpUrl", "mcpTransport", "apiBaseUrl", "apiDocsUrl", "authHeader", "howToGetKey", "loginUrl", "appUrl", "notes"],
  properties: {
    mcpUrl: { type: ["string", "null"], description: "Полный URL официального удалённого MCP-сервера сервиса, если он есть" },
    mcpTransport: { type: ["string", "null"], description: "streamable_http или sse, если известно" },
    apiBaseUrl: { type: ["string", "null"], description: "Базовый URL публичного REST/GraphQL API" },
    apiDocsUrl: { type: ["string", "null"], description: "Страница документации API" },
    authHeader: { type: ["string", "null"], description: "Имя HTTP-заголовка для ключа, обычно Authorization" },
    howToGetKey: { type: ["string", "null"], description: "Где в интерфейсе сервиса взять API-ключ или токен" },
    loginUrl: { type: ["string", "null"] },
    appUrl: { type: ["string", "null"] },
    notes: { type: "string", description: "Короткая заметка для следующего агента, без секретов" },
  },
} as const;

interface ModelFindings {
  mcpUrl: string | null;
  mcpTransport: McpTransport | null;
  apiBaseUrl: string | null;
  apiDocsUrl: string | null;
  authHeader: string | null;
  howToGetKey: string | null;
  loginUrl: string | null;
  appUrl: string | null;
  notes: string;
}

const EMPTY_FINDINGS: ModelFindings = {
  mcpUrl: null,
  mcpTransport: null,
  apiBaseUrl: null,
  apiDocsUrl: null,
  authHeader: null,
  howToGetKey: null,
  loginUrl: null,
  appUrl: null,
  notes: "",
};

function parseFindings(text: string): ModelFindings {
  try {
    const raw = JSON.parse(text) as Partial<Record<keyof ModelFindings, unknown>>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const transportRaw = str(raw.mcpTransport)?.toLowerCase() ?? "";
    return {
      mcpUrl: str(raw.mcpUrl),
      mcpTransport: /sse/.test(transportRaw) ? "sse" : /http/.test(transportRaw) ? "streamable_http" : null,
      apiBaseUrl: str(raw.apiBaseUrl),
      apiDocsUrl: str(raw.apiDocsUrl),
      authHeader: str(raw.authHeader),
      howToGetKey: str(raw.howToGetKey),
      loginUrl: str(raw.loginUrl),
      appUrl: str(raw.appUrl),
      notes: str(raw.notes) ?? "",
    };
  } catch {
    return EMPTY_FINDINGS;
  }
}

function searchPrompt(service: string, domain: string | null): string {
  return [
    `Нужно подключиться к сервису «${service}»${domain ? ` (${domain})` : ""} программно.`,
    "По результатам поиска найди в официальной документации:",
    "1) есть ли у сервиса официальный удалённый MCP-сервер (URL вида https://mcp.<домен>/mcp или из раздела интеграций);",
    "2) публичный REST или GraphQL API: базовый URL, страница документации, заголовок авторизации, где взять ключ;",
    "3) адрес входа в веб-приложение.",
    "Указывай только URL, которые встречаются в результатах. Не выдумывай адреса. Верни JSON.",
  ].join("\n");
}

function extractPrompt(service: string, domain: string | null, prior: ModelFindings, pages: FetchedPage[]): string {
  const docs = pages
    .map((p) => `### ${p.title || p.finalUrl}\nURL: ${p.finalUrl}\n${p.text}`)
    .join("\n\n");
  return [
    `Сервис «${service}»${domain ? ` (${domain})` : ""}. Ниже страницы его документации.`,
    "Извлеки точные данные для подключения: URL удалённого MCP-сервера и его транспорт, базовый URL API,",
    "страницу документации API, заголовок авторизации, как получить ключ, адрес входа. Чего нет на страницах — null.",
    "Предыдущие находки из поиска (можно уточнить или опровергнуть):",
    JSON.stringify(prior),
    "",
    docs,
  ].join("\n");
}

async function askModel(
  deps: DiscoveryDeps,
  action: string,
  prompt: string,
  webSearch: { maxResults: number } | null,
): Promise<{ findings: ModelFindings; citations: WebCitation[] } | null> {
  if (!deps.openRouter) return null;
  try {
    const r = await deps.openRouter.chat(
      [{ role: "user", content: prompt }],
      {
        jsonSchema: { name: "service_findings", schema: FINDINGS_SCHEMA },
        temperature: 0,
        maxTokens: 700,
        ...(webSearch ? { webSearch } : {}),
      },
      deps.model,
    );
    await deps.onUsage?.(action, r);
    return { findings: parseFindings(r.text), citations: r.citations };
  } catch (e) {
    warn("discovery", `модель не ответила (${action})`, { error: String(e) });
    return null;
  }
}

// --- Сборка -------------------------------------------------------------------

function httpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function belongsTo(url: string, domain: string | null): boolean {
  return domain !== null && sameBrand(hostOf(url), domain);
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

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

/** Первый подтверждённый MCP из списка кандидатов; остальные пробы не ждём. */
async function verifyCandidates(candidates: McpFinding[], fetchImpl: typeof fetch): Promise<McpFinding | null> {
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

export async function discoverService(input: DiscoveryInput, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registryUrl = deps.registryUrl ?? MCP_REGISTRY_URL;
  const domain = pickServiceDomain(input.domain, input.links);
  const slug = slugFor(domain, input.service);
  const service = input.service?.trim() || (domain ? slug.charAt(0).toUpperCase() + slug.slice(1) : "Сервис");
  const step = async (text: string, data?: Record<string, unknown>) => deps.onStep?.(text, data);

  await step(`ищу способ входа в ${service}${domain ? ` (${domain})` : ""}`);

  // 1. Реестр MCP и типовые адреса на домене — параллельно, оба без модели.
  const candidates: McpFinding[] = [];
  if (domain) {
    const fromRegistry = await searchRegistry(slug, domain, registryUrl, fetchImpl);
    candidates.push(...fromRegistry);
    if (fromRegistry.length) await step(`реестр MCP: ${fromRegistry.length} адрес(ов) для ${domain}`);
    candidates.push(...wellKnownMcpUrls(domain).map((w) => ({ ...w, auth: "bearer" as const, source: "well-known" as const, verified: false })));
  }
  let mcp = candidates.length ? await verifyCandidates(candidates, fetchImpl) : null;
  if (mcp) await step(`MCP найден: ${mcp.url} (${mcp.auth === "none" ? "без токена" : mcp.auth})`, { source: mcp.source });

  // 2. Документация: типовые адреса на домене + поиск в интернете.
  const docs: DocFinding[] = [];
  const pagesToRead: string[] = [];
  if (domain) {
    const probes = await Promise.all(likelyDocsUrls(domain).map((u) => fetchPage(u, fetchImpl, 400)));
    for (const p of probes) {
      if (!p || p.status >= 300 || !p.text) continue;
      if (docs.some((d) => d.url === p.finalUrl)) continue;
      docs.push({ url: p.finalUrl, title: p.title, excerpt: excerpt(p.text) });
      pagesToRead.push(p.finalUrl);
    }
  }

  let findings = EMPTY_FINDINGS;
  const searched = await askModel(deps, "discover.search", searchPrompt(service, domain), { maxResults: 8 });
  if (searched) {
    findings = searched.findings;
    for (const c of searched.citations) {
      if (isNoiseDomain(hostOf(c.url)) || docs.some((d) => d.url === c.url)) continue;
      docs.push({ url: c.url, title: c.title, excerpt: excerpt(c.content) });
    }
    await step(`поиск в интернете: ${searched.citations.length} источник(ов)`);
  }

  // 3. Читаем до трёх страниц документации: сперва с домена сервиса, потом из поиска.
  const readOrder = [
    ...pagesToRead,
    ...[findings.apiDocsUrl, ...docs.map((d) => d.url)].filter((u): u is string => Boolean(u)),
  ]
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .sort((a, b) => Number(belongsTo(b, domain)) - Number(belongsTo(a, domain)))
    .slice(0, 3);
  if (readOrder.length && deps.openRouter) {
    const pages = (await Promise.all(readOrder.map((u) => fetchPage(u, fetchImpl)))).filter(
      (p): p is FetchedPage => p !== null && p.status < 300 && p.text.length > 200,
    );
    if (pages.length) {
      const extracted = await askModel(deps, "discover.extract", extractPrompt(service, domain, findings, pages), null);
      if (extracted) {
        const f = extracted.findings;
        findings = {
          mcpUrl: f.mcpUrl ?? findings.mcpUrl,
          mcpTransport: f.mcpTransport ?? findings.mcpTransport,
          apiBaseUrl: f.apiBaseUrl ?? findings.apiBaseUrl,
          apiDocsUrl: f.apiDocsUrl ?? findings.apiDocsUrl,
          authHeader: f.authHeader ?? findings.authHeader,
          howToGetKey: f.howToGetKey ?? findings.howToGetKey,
          loginUrl: f.loginUrl ?? findings.loginUrl,
          appUrl: f.appUrl ?? findings.appUrl,
          notes: f.notes || findings.notes,
        };
      }
      await step(`прочитана документация: ${pages.map((p) => p.title || p.finalUrl).join("; ")}`.slice(0, 300));
    }
  }

  // 4. MCP из документации проверяем так же, как остальные.
  const docMcp = httpsUrl(findings.mcpUrl);
  if (!mcp && docMcp) {
    const transport: McpTransport = findings.mcpTransport ?? (/\/sse\b/.test(docMcp) ? "sse" : "streamable_http");
    const probe = await probeMcp(docMcp, transport, fetchImpl);
    if (probe?.ok) {
      mcp = { url: probe.url ?? docMcp, transport, auth: probe.auth, source: "docs", verified: true };
      await step(`MCP из документации подтверждён: ${mcp.url}`);
    } else if (probe === null) {
      // Сеть не ответила — адрес из документации остаётся как непроверенная подсказка.
      mcp = { url: docMcp, transport, auth: "bearer", source: "docs", verified: false };
      await step(`MCP из документации не ответил: ${docMcp}`);
    } else {
      // Сервер ответил, но это не MCP: модель выдумала адрес или он устарел.
      await step(`адрес MCP из документации не подтвердился: ${docMcp} (${probe.status})`);
    }
  }

  const api: ApiFinding | null =
    findings.apiBaseUrl || findings.apiDocsUrl
      ? {
          baseUrl: httpsUrl(findings.apiBaseUrl),
          docsUrl: httpsUrl(findings.apiDocsUrl) ?? docs.find((d) => belongsTo(d.url, domain))?.url ?? null,
          authHeader: findings.authHeader || "Authorization",
          howToGetKey: findings.howToGetKey ?? "",
        }
      : null;

  // Ссылка из самого приглашения — лучший адрес входа, если документация не сказала иного.
  const inviteLink = input.links.map((l) => httpsUrl(l)).find((l): l is string => l !== null && belongsTo(l, domain)) ?? null;
  const appUrl = httpsUrl(findings.appUrl) ?? (domain ? `https://${domain}/` : null);
  const loginUrl = httpsUrl(findings.loginUrl) ?? inviteLink ?? (domain ? `https://${domain}/login` : null);
  const browser = appUrl && loginUrl ? { loginUrl, appUrl } : null;

  const notes = [
    findings.notes,
    mcp ? `MCP: ${mcp.url} (${mcp.transport}, auth ${mcp.auth}${mcp.verified ? ", проверен" : ", не проверен"}).` : "Официальный MCP не найден.",
    api?.docsUrl ? `Документация API: ${api.docsUrl}.` : "",
    api?.howToGetKey ? `Ключ: ${api.howToGetKey}.` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 1000);

  const draftRecipe = composeRecipe({ slug, name: service, domain, mcp, api, browser, notes, agentId: deps.agentId });
  const confirmed = Boolean(mcp?.verified && (mcp.source !== "docs" || belongsTo(mcp.url, domain)));

  await step(
    draftRecipe
      ? `черновик рецепта: ${draftRecipe.kind}${confirmed ? ", MCP подтверждён" : ""}`
      : "способ входа не найден, остаётся браузер по ссылке из приглашения",
  );

  return { service, slug, domain, mcp, api, browser, docs: docs.slice(0, 8), notes, draftRecipe, confirmed };
}
