import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { findSlackInstall, upsertCredential, upsertRecipe } from "@swarm/connections";
import { decryptJson } from "@swarm/crypto";
import { env } from "@/env";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { pushServicesToAgent } from "@/lib/create-agent";
import { exchangeSlackCode, slackRedirectUri, slackServiceRecipe } from "@/lib/slack";

/**
 * Callback Slack. Браузер агента приходит сюда без сессии владельца:
 * state зашифрован и живёт 15 минут. Если владелец всё же открыл ссылку сам,
 * тенант сессии должен совпасть.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) return NextResponse.redirect(new URL("/?error=slack_denied", env.appUrl));

  let state: { agentId: string; tenantId: string; at: number };
  try {
    state = decryptJson(stateRaw);
  } catch {
    return NextResponse.redirect(new URL("/?error=slack_state", env.appUrl));
  }
  const viewer = await getViewer();
  if ((viewer && viewer.tenant.id !== state.tenantId) || Date.now() - state.at > 15 * 60 * 1000) {
    return NextResponse.redirect(new URL("/?error=slack_state", env.appUrl));
  }
  const agent = await getAgent(db(), state.tenantId, state.agentId);
  if (!agent) return NextResponse.redirect(new URL("/?error=agent_missing", env.appUrl));

  const clientId = env.slack.clientId;
  const clientSecret = env.slack.clientSecret;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`/agents/${agent.id}?error=slack_not_configured`, env.appUrl));
  }

  let installed;
  try {
    installed = await exchangeSlackCode(
      { clientId, clientSecret, redirectUri: slackRedirectUri(env.appUrl) },
      code,
    );
  } catch (e) {
    console.warn(`[slack] обмен кода: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.redirect(new URL(`/agents/${agent.id}?error=slack_exchange`, env.appUrl));
  }

  const owner = await findSlackInstall(db(), installed.userId);
  if (owner && owner.agentId !== agent.id) {
    return NextResponse.redirect(new URL(`/agents/${agent.id}?error=slack_taken`, env.appUrl));
  }

  await upsertRecipe(db(), slackServiceRecipe(), agent.id);
  await upsertCredential(
    db(),
    { tenantId: agent.tenantId, agentId: agent.id },
    {
      slug: "slack",
      kind: "api",
      token: installed.userToken,
      oauth: { accessToken: installed.userToken, scope: installed.scope },
      accountName: installed.displayName,
      externalKey: installed.userId,
    },
  );
  try {
    await pushServicesToAgent(agent);
  } catch (e) {
    console.warn(`[slack] не удалось отдать токен на машину: ${e instanceof Error ? e.message : String(e)}`);
  }
  return NextResponse.redirect(new URL(`/agents/${agent.id}?slack=connected`, env.appUrl));
}
