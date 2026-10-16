import type { ServiceCredential, ServiceRecipe, ServicesSnapshot } from "@swarm/contracts";
import { hostOf, matchRecipe, rootDomain } from "../onboarding/domains";

type RecipeMode = Pick<ServiceRecipe, "kind" | "mcp">;
type CredMode = Pick<ServiceCredential, "kind" | "token" | "oauth">;

/**
 * Способ, которым сервис уже подключён и которым надо делать задачи.
 * null — ключа ещё нет или способ браузерный: браузер для входа и работы разрешён.
 */
export function programmedChannel(recipe: RecipeMode, cred: CredMode | undefined): "mcp" | "api" | null {
  if (!cred) return null;
  if (mcpReady(recipe, cred)) return "mcp";
  if (apiReady(recipe, cred)) return "api";
  return null;
}

function mcpReady(recipe: RecipeMode, cred: CredMode): boolean {
  if (!recipe.mcp) return false;
  if (recipe.kind !== "mcp" && cred.kind !== "mcp") return false;
  if (recipe.mcp.auth === "none") return true;
  if (recipe.mcp.auth === "oauth") return Boolean(cred.oauth?.accessToken);
  return cred.kind !== "browser" && Boolean(cred.token);
}

function apiReady(recipe: RecipeMode, cred: CredMode): boolean {
  if (recipe.kind !== "api" && cred.kind !== "api") return false;
  return Boolean(cred.token || cred.oauth?.accessToken);
}

function recipeOf(services: ServicesSnapshot, slug: string | null, url: string | null): ServiceRecipe | null {
  if (slug) {
    const bySlug = services.recipes.find((recipe) => recipe.slug === slug);
    if (bySlug) return bySlug;
  }
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  return matchRecipe(services.recipes, [host, rootDomain(host)]);
}

/**
 * Человек прямо просит войти в сервис через браузер.
 * Плановая проверка и уведомления сюда не попадают: смотрим только его текст.
 */
export function userRequestsBrowser(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, "е");
  if (/не\s+через\s+браузер|не\s+в\s+браузере|без\s+браузера|не\s+браузером/.test(t)) return false;
  if (/\b(not|don'?t|do not|without)\b[\s\S]{0,24}\bbrowser\b/.test(t)) return false;
  if (/через\s+браузер/.test(t)) return true;
  if (/(?:зайди|зайти|войди|войти|залогин\w*|авториз\w*)\s+браузером/.test(t)) return true;
  if (/(?:открой|открыть)\s+браузер(?:\s|$|[.,!])/.test(t)) return true;
  if (/\b(via|through)\s+(the\s+)?browser\b/.test(t)) return true;
  if (/\b(open|use)\s+(the\s+)?browser\b/.test(t)) return true;
  if (/\b(log|sign)\s*in\b[\s\S]{0,40}\bbrowser\b/.test(t)) return true;
  return false;
}

/**
 * Задача в сервисе со способом API или MCP не открывает браузер.
 * Ключа ещё нет — браузер можно, чтобы его выпустить.
 * Человек прямо попросил зайти через браузер — тоже можно.
 */
export function browserTaskBlock(
  services: ServicesSnapshot | null,
  args: { slug?: string | null; url?: string | null; userAsked?: boolean },
): string | null {
  if (args.userAsked) return null;
  if (!services) return null;
  const recipe = recipeOf(services, args.slug ?? null, args.url ?? null);
  if (!recipe) return null;
  const cred = services.credentials.find((item) => item.slug === recipe.slug);
  const channel = programmedChannel(recipe, cred);
  if (channel === "mcp") {
    return `«${recipe.name}» подключён через MCP. Задачу выполняй инструментами mcp_${recipe.slug}_*, браузер не открывай. Если токен отвергнут — запиши /report с token: null и выпусти новый.`;
  }
  if (channel === "api") {
    const base = recipe.api?.baseUrl ? ` (${recipe.api.baseUrl})` : "";
    return `«${recipe.name}» подключён через API. Задачу выполняй curl к API${base}, браузер не открывай. Если ключ отвергнут — запиши /report с token: null и тогда выпусти новый в кабинете.`;
  }
  return null;
}
