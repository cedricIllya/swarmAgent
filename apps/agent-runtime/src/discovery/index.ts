import { isConcreteReadUrl } from "../onboarding/connect";
import { hostOf, isNoiseDomain, pickServiceDomain, slugFor } from "../onboarding/domains";
import { httpsUrl } from "./http";
import { probeMcp, verifyCandidates, wellKnownMcpUrls } from "./mcp-probe";
import { EMPTY_FINDINGS, askModel, extractPrompt, mergeFindings, searchCovers, searchPrompt, type ModelFindings } from "./model";
import { excerpt, fallbackDocsUrls, fetchPage, pickDocsSeed, selectDocPages } from "./pages";
import { belongsTo, composeRecipe } from "./recipe";
import { searchRegistry } from "./registry";
import {
  MCP_REGISTRY_URL,
  type ApiFinding,
  type DiscoveryDeps,
  type DiscoveryInput,
  type DiscoveryResult,
  type DocFinding,
  type McpFinding,
  type McpTransport,
} from "./types";

export { interpretMcpResponse, mcpToolNames, probeMcp, verifyCandidates, wellKnownMcpUrls, type McpProbe } from "./mcp-probe";
export { matchRegistryServers, registryNameDomain, type RegistryEntry } from "./registry";
export { fallbackDocsUrls, fetchPage, htmlToText, pickDocsSeed, rankDocLinks, scoreDocUrl, selectDocPages, type FetchedPage } from "./pages";
export { searchCovers } from "./model";
export { composeRecipe } from "./recipe";
export * from "./types";

function rememberDoc(docs: DocFinding[], url: string, title: string, text: string): void {
  if (docs.some((doc) => doc.url === url)) return;
  docs.push({ url, title, excerpt: excerpt(text) });
}

/** Адрес из поиска годится, только если он этого сервиса. Чужой MCP вроде GitVerse для Gensite — нет. */
function onService(url: string | null, domain: string | null): string | null {
  if (!url) return null;
  if (!domain) return url;
  return belongsTo(url, domain) ? url : null;
}

function keepServiceFindings(findings: ModelFindings, domain: string | null): ModelFindings {
  if (!domain) return findings;
  const mcpUrl = onService(findings.mcpUrl, domain);
  const apiBaseUrl = onService(findings.apiBaseUrl, domain);
  const apiDocsUrl = onService(findings.apiDocsUrl, domain);
  const keyPageUrl = onService(findings.keyPageUrl, domain);
  const loginUrl = onService(findings.loginUrl, domain);
  const appUrl = onService(findings.appUrl, domain);
  const readEndpoints = findings.readEndpoints.filter((url) => belongsTo(url, domain));
  const keptUrl = Boolean(mcpUrl || apiBaseUrl || apiDocsUrl || keyPageUrl || loginUrl || appUrl || readEndpoints.length);
  const droppedForeign = Boolean(
    (findings.mcpUrl && !mcpUrl) ||
      (findings.apiBaseUrl && !apiBaseUrl) ||
      (findings.apiDocsUrl && !apiDocsUrl) ||
      (findings.keyPageUrl && !keyPageUrl) ||
      (findings.loginUrl && !loginUrl) ||
      (findings.appUrl && !appUrl) ||
      findings.readEndpoints.some((url) => !belongsTo(url, domain)),
  );
  return {
    ...findings,
    mcpUrl,
    apiBaseUrl,
    apiDocsUrl,
    keyPageUrl,
    loginUrl,
    appUrl,
    readEndpoints,
    howToGetKey: droppedForeign && !keptUrl ? null : findings.howToGetKey,
    notes: droppedForeign && !keptUrl ? "" : findings.notes,
  };
}

/**
 * Поиск способа входа в сервис, которого нет в общем каталоге:
 * официальный реестр MCP → типовые адреса MCP на домене → один веб-поиск.
 * Страницы читаются только если поиск не закрыл подключение: корень из цитат,
 * `llms.txt` и одна страница про API или ключ. Каждый найденный MCP проверяется
 * настоящим `initialize`, поэтому рецепт `kind: mcp` можно записывать сразу.
 */
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

  // 2. Документация — один поиск. Страницы читаем, только если в ответе не хватает способа подключения.
  const docs: DocFinding[] = [];
  let findings = EMPTY_FINDINGS;
  const skipDocs = Boolean(mcp?.verified && mcp.auth === "none");
  if (skipDocs) {
    await step("MCP открыт без токена, документацию не ищу");
  } else if (deps.openRouter) {
    const searched = await askModel(deps, "discover.search", searchPrompt(service, domain), { maxResults: 5 });
    if (searched) {
      findings = keepServiceFindings(searched.findings, domain);
      for (const citation of searched.citations) {
        if (isNoiseDomain(hostOf(citation.url)) || docs.some((doc) => doc.url === citation.url)) continue;
        if (domain && !belongsTo(citation.url, domain)) continue;
        docs.push({ url: citation.url, title: citation.title, excerpt: excerpt(citation.content) });
      }
      await step(`поиск в интернете: ${searched.citations.length} источник(ов)`);
    }

    if (searched && searchCovers(findings, searched.citations)) {
      await step("поиск уже дал способ подключения, страницы не читаю");
    } else {
      let seed = pickDocsSeed(domain, findings.apiDocsUrl, docs.map((doc) => doc.url));
      if (!seed && domain) {
        const probes = await Promise.all(fallbackDocsUrls(domain).map((url) => fetchPage(url, fetchImpl, 400)));
        const hit = probes.find((page) => page && page.status < 300 && page.text.length > 40);
        if (hit) {
          seed = hit.finalUrl;
          rememberDoc(docs, hit.finalUrl, hit.title, hit.text);
        }
      }
      if (seed) {
        const pages = await selectDocPages(seed, domain, fetchImpl);
        for (const page of pages) rememberDoc(docs, page.finalUrl, page.title, page.text);
        if (!docs.some((doc) => doc.url === seed)) rememberDoc(docs, seed, "", "");
        if (pages.length) {
          const extracted = await askModel(deps, "discover.extract", extractPrompt(service, domain, findings, pages), null);
          if (extracted) findings = keepServiceFindings(mergeFindings(findings, extracted.findings), domain);
          await step(`прочитана документация: ${pages.map((page) => page.title || page.finalUrl).join("; ")}`.slice(0, 300));
        }
      }
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
          keyPageUrl: httpsUrl(findings.keyPageUrl),
          readEndpoints: (findings.readEndpoints ?? []).map((u) => httpsUrl(u)).filter((u): u is string => u !== null && isConcreteReadUrl(u)),
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
