import type { WebCitation } from "../openrouter";
import { warn } from "../log";
import { httpsUrl } from "./http";
import type { FetchedPage } from "./pages";
import type { DiscoveryDeps, McpTransport } from "./types";

/** Модель: поиск в интернете и извлечение данных для подключения из документации. */

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
    keyPageUrl: { type: ["string", "null"], description: "Точный URL страницы, где залогиненный пользователь создаёт API-ключ. Только если он есть в источниках" },
    readEndpoints: {
      type: "array",
      items: { type: "string" },
      description: "До трёх GET без параметров пути: текущий пользователь, аккаунт, список. Только URL из источников",
    },
    loginUrl: { type: ["string", "null"] },
    appUrl: { type: ["string", "null"] },
    notes: { type: "string", description: "Короткая заметка для следующего агента, без секретов" },
  },
} as const;

export interface ModelFindings {
  mcpUrl: string | null;
  mcpTransport: McpTransport | null;
  apiBaseUrl: string | null;
  apiDocsUrl: string | null;
  authHeader: string | null;
  howToGetKey: string | null;
  loginUrl: string | null;
  appUrl: string | null;
  notes: string;
  keyPageUrl: string | null;
  readEndpoints: string[];
}

export const EMPTY_FINDINGS: ModelFindings = {
  mcpUrl: null,
  mcpTransport: null,
  apiBaseUrl: null,
  apiDocsUrl: null,
  authHeader: null,
  howToGetKey: null,
  loginUrl: null,
  appUrl: null,
  notes: "",
  keyPageUrl: null,
  readEndpoints: [],
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
      keyPageUrl: str(raw.keyPageUrl),
      readEndpoints: Array.isArray(raw.readEndpoints)
        ? raw.readEndpoints.filter((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v)).slice(0, 3)
        : [],
    };
  } catch {
    return EMPTY_FINDINGS;
  }
}

/** Новые находки поверх старых: что модель не нашла на страницах, остаётся из поиска. */
export function mergeFindings(prior: ModelFindings, next: ModelFindings): ModelFindings {
  return {
    mcpUrl: next.mcpUrl ?? prior.mcpUrl,
    mcpTransport: next.mcpTransport ?? prior.mcpTransport,
    apiBaseUrl: next.apiBaseUrl ?? prior.apiBaseUrl,
    apiDocsUrl: next.apiDocsUrl ?? prior.apiDocsUrl,
    authHeader: next.authHeader ?? prior.authHeader,
    howToGetKey: next.howToGetKey ?? prior.howToGetKey,
    loginUrl: next.loginUrl ?? prior.loginUrl,
    appUrl: next.appUrl ?? prior.appUrl,
    notes: next.notes || prior.notes,
    keyPageUrl: next.keyPageUrl ?? prior.keyPageUrl,
    readEndpoints: next.readEndpoints.length ? next.readEndpoints : prior.readEndpoints,
  };
}

/** Поиска хватает, если он назвал базу API, страницу документации из цитат и где взять ключ. */
export function searchCovers(findings: ModelFindings, citations: WebCitation[]): boolean {
  const docs = httpsUrl(findings.apiDocsUrl);
  if (!httpsUrl(findings.apiBaseUrl) || !docs || !findings.howToGetKey) return false;
  let docsHost = "";
  try {
    docsHost = new URL(docs).host;
  } catch {
    return false;
  }
  return citations.some((citation) => {
    const cited = httpsUrl(citation.url);
    if (!cited) return false;
    try {
      if (new URL(cited).host !== docsHost) return false;
    } catch {
      return false;
    }
    return cited === docs || cited.startsWith(docs) || docs.startsWith(cited);
  });
}

export function searchPrompt(service: string, domain: string | null): string {
  return [
    `Нужно подключиться к сервису «${service}»${domain ? ` (${domain})` : ""} программно.`,
    "По результатам поиска найди в официальной документации:",
    "1) есть ли у сервиса официальный удалённый MCP-сервер (URL вида https://mcp.<домен>/mcp или из раздела интеграций);",
    "2) публичный REST или GraphQL API: базовый URL, страница документации, заголовок авторизации (если не уверен — null, не угадывай Authorization), точный URL страницы создания ключа, два-три GET без параметров;",
    "3) адрес входа в веб-приложение.",
    "Указывай только URL, которые встречаются в результатах. Не выдумывай адреса. Верни JSON.",
  ].join("\n");
}

export function extractPrompt(service: string, domain: string | null, prior: ModelFindings, pages: FetchedPage[]): string {
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

export async function askModel(
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
