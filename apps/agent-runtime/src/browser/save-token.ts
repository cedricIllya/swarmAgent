import type { ServiceCredential, ServiceRecipe } from "@swarm/contracts";
import type { AgentRuntime } from "../runtime";
import { mcpTokenCheck, type TokenCheck } from "../report-guard";
import type { ManagedBrowserSession } from "./stagehand";

export type TokenPick = { token: string; verified: boolean | null } | { token: null; rejected: number };

/**
 * Какую строку со страницы считать токеном. MCP-рецепт проверяет каждую `initialize`:
 * первая принятая — токен; отказы отбрасываются. Без MCP проверять нечем — берём одну
 * строку, только если она на странице единственная.
 */
export async function pickPageToken(recipe: ServiceRecipe | null, candidates: string[], check: TokenCheck): Promise<TokenPick> {
  const list = candidates.slice(0, 8);
  const mcp = recipe?.mcp && recipe.mcp.auth !== "none" && recipe.mcp.auth !== "oauth" ? recipe : null;
  if (!mcp) return list.length === 1 ? { token: list[0]!, verified: null } : { token: null, rejected: 0 };
  let unknown: string | null = null;
  let rejected = 0;
  for (const token of list) {
    const verdict = await check(mcp, token).catch(() => null);
    if (verdict === true) return { token, verified: true };
    if (verdict === false) rejected += 1;
    else unknown ??= token;
  }
  return unknown ? { token: unknown, verified: null } : { token: null, rejected };
}

type Reply = { status: 200 | 404 | 409 | 422; body: Record<string, unknown> };

export async function saveTokenFromPage(rt: AgentRuntime, s: ManagedBrowserSession, check: TokenCheck = mcpTokenCheck): Promise<Reply> {
  const slug = s.serviceSlug!;
  const runId = s.meta.runId;
  const snap = await rt.store.readServices();
  const recipe = snap?.recipes.find((r) => r.slug === slug) ?? null;
  const prev = snap?.credentials.find((c) => c.slug === slug);
  const reading = await s.read();
  if (!reading.tokens.length) {
    return { status: 404, body: { saved: false, error: "на странице нет строки, похожей на токен: выпусти токен, дождись, пока он покажется, и вызови снова" } };
  }
  const pick = await pickPageToken(recipe, reading.tokens, check);
  if (pick.token === null) {
    const error = pick.rejected
      ? `сервис не принял ни одну из ${pick.rejected} строк со страницы: выпусти новый токен и вызови снова`
      : `на странице ${reading.tokens.length} похожих строк, а проверить их нечем: открой страницу, где виден только новый токен`;
    if (runId) await rt.step(runId, "note", `токен ${slug} не сохранён: ${error}`);
    return { status: 422, body: { saved: false, error } };
  }
  const kind: ServiceCredential["kind"] = recipe?.kind === "api" || (!recipe?.mcp && recipe?.api) ? "api" : "mcp";
  const credential: ServiceCredential = {
    slug,
    kind,
    token: pick.token,
    accountEmail: prev?.accountEmail ?? rt.cfg.email,
    ...(prev?.accountName ? { accountName: prev.accountName } : {}),
  };
  await rt.services.applyReport({ type: "credential", credential, ...(runId ? { runId } : {}) });
  const how = pick.verified ? "MCP принял его" : "проверить вызовом не удалось";
  if (runId) await rt.step(runId, "note", `токен ${slug} сохранён в доступ рядом с паролем, ${how}`);
  return { status: 200, body: { saved: true, verified: pick.verified, kind } };
}
