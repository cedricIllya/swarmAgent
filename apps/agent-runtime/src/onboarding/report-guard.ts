import { messengerPatch, type ServiceCredential, type ServiceRecipe } from "@swarm/contracts";
import { hostOf, sameBrand } from "./domains";
import { mcpToolNames } from "../discovery";

/**
 * Отчёты модели через /report идут в общий каталог и в её же доступы. Модель ошибается:
 * приписывала Gensite документацию и вход чужого сайта, записывала выдуманный токен.
 * Здесь — что из отчёта можно принять.
 */

export type Guard<T> = { ok: true; value: T; note: string | null } | { ok: false; reason: string };

function urlsOf(r: ServiceRecipe): string[] {
  return [r.mcp?.url, r.api?.baseUrl, r.api?.docsUrl, r.browser?.loginUrl, r.browser?.appUrl].filter(
    (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
  );
}

function onBrand(url: string, domains: string[]): boolean {
  const host = hostOf(url);
  return domains.some((d) => sameBrand(host, d));
}

/** Рецепт от модели: новый — все адреса одного бренда с доменами; известный — ядро не трогать. */
export function guardRecipeReport(existing: ServiceRecipe | null, incoming: ServiceRecipe): Guard<ServiceRecipe> {
  const domains = existing?.domains.length ? existing.domains : incoming.domains;
  if (!domains.length) return { ok: false, reason: "в рецепте нет domains: укажи домен сервиса" };
  const foreign = urlsOf(incoming).filter((u) => !onBrand(u, domains));
  if (foreign.length) {
    return {
      ok: false,
      reason: `адреса ${foreign.join(", ")} не принадлежат ${domains.join(", ")}: это другой сайт, в рецепт ${incoming.slug} он не пойдёт`,
    };
  }
  // Пометку «сервис для задач» ставит разбор документации, не отчёт модели с пустого захода.
  if (!existing) return { ok: true, value: messengerPatch({ ...incoming, watchesTasks: null }), note: null };

  const browser = incoming.browser ?? existing.browser;
  const merged: ServiceRecipe = {
    ...existing,
    name: existing.name,
    kind: existing.kind,
    domains: Array.from(new Set([...existing.domains, ...incoming.domains.filter((d) => domains.some((k) => sameBrand(d, k)))])),
    ...(existing.mcp ? { mcp: existing.mcp } : incoming.mcp ? { mcp: incoming.mcp } : {}),
    ...(existing.api ? { api: existing.api } : incoming.api ? { api: incoming.api } : {}),
    ...(browser ? { browser } : {}),
    notes: existing.notes?.trim() ? existing.notes : incoming.notes,
  };
  const dropped = [
    incoming.mcp && existing.mcp && JSON.stringify(incoming.mcp) !== JSON.stringify(existing.mcp) ? "mcp" : null,
    incoming.api && existing.api && JSON.stringify(incoming.api) !== JSON.stringify(existing.api) ? "api" : null,
    incoming.notes && existing.notes?.trim() && incoming.notes !== existing.notes ? "notes" : null,
    incoming.kind !== existing.kind ? "kind" : null,
  ].filter(Boolean);
  return {
    ok: true,
    value: messengerPatch(merged),
    note: dropped.length ? `рецепт ${existing.slug} уже в каталоге: поля ${dropped.join(", ")} оставлены прежними` : null,
  };
}

export type TokenCheck = (recipe: ServiceRecipe, token: string) => Promise<boolean | null>;

/** 401/403 на initialize — токен не принят; инструменты есть — принят; иначе неизвестно. */
export async function mcpTokenCheck(recipe: ServiceRecipe, token: string, fetchImpl: typeof fetch = fetch): Promise<boolean | null> {
  const url = recipe.mcp?.url;
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "swarm-agent", version: "0.1.0" } },
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "manual",
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401 || res.status === 403) return false;
  } catch {
    return null;
  }
  const names = await mcpToolNames(url, fetchImpl, token);
  return names === null ? null : names.length > 0;
}

/**
 * Доступ от модели: токен для MCP-рецепта принимается, только если сервер отдал с ним
 * инструменты. null от проверки — сервер недоступен, верим на слово.
 */
export async function guardCredentialReport(
  recipe: ServiceRecipe | null,
  incoming: ServiceCredential,
  checkToken: TokenCheck,
): Promise<Guard<ServiceCredential>> {
  const token = incoming.token;
  if (!token) return { ok: true, value: incoming, note: null };
  if (token.length < 8 || /[<>…]|\bxxx|пример|example|placeholder|твой|your[-_ ]?token/i.test(token)) {
    return { ok: false, reason: "токен похож на заглушку, а не на выпущенное значение — запиши настоящий" };
  }
  if (recipe?.mcp && recipe.mcp.auth !== "none" && recipe.mcp.auth !== "oauth") {
    const verdict = await checkToken(recipe, token);
    if (verdict === false) {
      return { ok: false, reason: `MCP ${recipe.mcp.url} не принял этот токен (инструментов нет) — он не сохранён. Проверь, что скопировано полное значение` };
    }
  }
  return { ok: true, value: incoming, note: null };
}
