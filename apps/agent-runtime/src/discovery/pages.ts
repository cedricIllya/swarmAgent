import { hostOf, isNoiseDomain, sameBrand } from "../domains";
import { discardBody, httpsUrl, readHead } from "./http";
import { PROBE_TIMEOUT_MS } from "./types";

/**
 * Документация читается точечно: поиск называет страницу, с её хоста берутся
 * `llms.txt` и `sitemap.xml`, в модель уходят не больше двух страниц.
 */

const PAGE_LIMIT_BYTES = 400_000;
const PAGE_TEXT_CHARS = 9_000;
const INDEX_TEXT_CHARS = 4_000;
const ASSET_PATH = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|mp4|pdf)(\?|$)/i;

/** Три запасных корня, если поиск не назвал страницу документации. */
export function fallbackDocsUrls(domain: string): string[] {
  return [`https://docs.${domain}/`, `https://developers.${domain}/`, `https://${domain}/docs`];
}

/** Насколько URL похож на страницу про API, ключ или MCP. Ноль — не документация подключения. */
export function scoreDocUrl(raw: string): number {
  let path = "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return 0;
    path = `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return 0;
  }
  if (ASSET_PATH.test(path)) return 0;
  if (/llms\.txt$/.test(path)) return 100;
  if (/openapi|swagger/.test(path)) return 90;
  if (/mcp-server|model-context|\/mcp\b/.test(path)) return 80;
  if (/auth|api[-_]?key|\/tokens?\b/.test(path)) return 70;
  if (/api-reference|\/rest\b|\/api\b/.test(path)) return 60;
  if (/\/docs|\/developer/.test(path)) return 30;
  return 0;
}

/** Корень раздела, с которого ещё нужно выбрать конкретную страницу. */
function isIndexUrl(raw: string): boolean {
  try {
    const path = new URL(raw).pathname.toLowerCase().replace(/\/+$/, "") || "/";
    return path === "/" || path === "/llms.txt" || path.endsWith("/llms.txt") || path.endsWith("/sitemap.xml") || path.endsWith("/docs") || path.endsWith("/developers") || path.endsWith("/developer");
  } catch {
    return false;
  }
}

function absoluteHttpUrl(raw: string, base: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(mailto:|javascript:|tel:)/i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export function linksFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const abs = match[1] ? absoluteHttpUrl(match[1], base) : null;
    if (abs) out.push(abs);
  }
  return out;
}

export function linksFromMarkdown(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi)) {
    if (match[1]) out.push(match[1]);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    const url = match[0]?.replace(/[.,;]+$/, "");
    if (url) out.push(url);
  }
  return out;
}

export function linksFromSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!).filter(Boolean);
}

function linksFromRaw(url: string, contentType: string, raw: string): string[] {
  if (/html/i.test(contentType)) return linksFromHtml(raw, url);
  if (/xml/i.test(contentType) || /sitemap\.xml/i.test(url)) return linksFromSitemap(raw);
  return linksFromMarkdown(raw);
}

/**
 * Ссылки на подключение с одной страницы: тот же хост или тот же бренд,
 * сначала OpenAPI, MCP и авторизация.
 */
export function rankDocLinks(links: string[], domain: string | null, pageHost: string, skip: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const ranked: Array<{ url: string; score: number }> = [];
  for (const raw of links) {
    const url = absoluteHttpUrl(raw, pageHost ? `https://${pageHost}/` : raw);
    if (!url || skip.has(url) || seen.has(url)) continue;
    const score = scoreDocUrl(url);
    if (score <= 0) continue;
    const host = hostOf(url);
    if (isNoiseDomain(host)) continue;
    if (host !== pageHost && !(domain && sameBrand(host, domain))) continue;
    seen.add(url);
    ranked.push({ url, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.map((item) => item.url);
}

/** Страница, с которой читать документацию: названная поиском, иначе лучшая цитата того же сервиса. */
export function pickDocsSeed(domain: string | null, apiDocsUrl: string | null, citationUrls: string[]): string | null {
  const named = httpsUrl(apiDocsUrl);
  if (named && !isNoiseDomain(hostOf(named)) && (!domain || sameBrand(hostOf(named), domain))) return named;
  const ranked = citationUrls
    .map((url) => httpsUrl(url))
    .filter((url): url is string => url !== null && !isNoiseDomain(hostOf(url)))
    .filter((url) => !domain || sameBrand(hostOf(url), domain));
  ranked.sort((a, b) => scoreDocUrl(b) - scoreDocUrl(a));
  return ranked[0] ?? null;
}

function originIndex(pageUrl: string): { llms: string; sitemap: string } | null {
  try {
    const origin = new URL(pageUrl).origin;
    return { llms: `${origin}/llms.txt`, sitemap: `${origin}/sitemap.xml` };
  } catch {
    return null;
  }
}

function usable(page: FetchedPage | null, minChars: number): page is FetchedPage {
  return page !== null && page.status < 300 && page.text.length > minChars;
}

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
  links: string[];
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
    const finalUrl = res.url || url;
    if (!res.ok) {
      discardBody(res);
      return { url, finalUrl, status: res.status, title: "", text: "", links: [] };
    }
    const raw = await readHead(res, PAGE_LIMIT_BYTES);
    const links = linksFromRaw(finalUrl, contentType, raw);
    const page = /html/i.test(contentType) ? htmlToText(raw) : { title: "", text: raw.replace(/\s+/g, " ").trim() };
    return { url, finalUrl, status: res.status, title: page.title, text: page.text.slice(0, maxChars), links };
  } catch {
    return null;
  }
}

/**
 * До двух страниц с уже известного корня: `llms.txt`, если он есть, и одна
 * страница про API, ключ или MCP. Остальной сайт не читается.
 */
export async function selectDocPages(seed: string, domain: string | null, fetchImpl: typeof fetch): Promise<FetchedPage[]> {
  if (!isIndexUrl(seed)) {
    const page = await fetchPage(seed, fetchImpl);
    return usable(page, 40) ? [page] : [];
  }

  const index = originIndex(seed);
  const [llms, sitemap] = index
    ? await Promise.all([fetchPage(index.llms, fetchImpl, INDEX_TEXT_CHARS), fetchPage(index.sitemap, fetchImpl, 1_500)])
    : [null, null];
  const skip = new Set([seed, index?.llms, index?.sitemap].filter((url): url is string => Boolean(url)));
  let pageHost = "";
  try {
    pageHost = new URL(seed).host;
  } catch {
    pageHost = "";
  }

  const llmsPage = usable(llms, 40) ? llms : null;
  const links = [...(llmsPage?.links.length ? llmsPage.links : sitemap && sitemap.status < 300 ? sitemap.links : [])];
  let primary = llmsPage;
  if (!primary) {
    const page = await fetchPage(seed, fetchImpl);
    if (usable(page, 200)) {
      primary = page;
      if (!links.length) links.push(...page.links);
    }
  }

  const follow = rankDocLinks(links, domain, pageHost, skip)[0];
  const second = follow ? await fetchPage(follow, fetchImpl) : null;
  return [primary, usable(second, 40) ? second : null]
    .filter((page): page is FetchedPage => page !== null && !/sitemap\.xml/i.test(page.finalUrl))
    .slice(0, 2);
}

export function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}
