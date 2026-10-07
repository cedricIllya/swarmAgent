import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { findSlackInstall, upsertCredential, upsertRecipe } from "@swarm/connections";
import { decryptJson } from "@swarm/crypto";
import { env } from "@/env";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { pushServicesToAgent } from "@/lib/create-agent";
import { exchangeSlackCode, slackRedirectUri, slackServiceRecipe } from "@/lib/slack";

/** Callback Slack: bot token шифруется в доступ агента, команда становится ключом вебхука. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/login", env.appUrl));
  if (!code || !stateRaw) return NextResponse.redirect(new URL("/?error=slack_denied", env.appUrl));

  let state: { agentId: string; tenantId: string; at: number };
  try {
    state = decryptJson(stateRaw);
  } catch {
    return NextResponse.redirect(new URL("/?error=slack_state", env.appUrl));
  }
  if (state.tenantId !== viewer.tenant.id || Date.now() - state.at > 15 * 60 * 1000) {
    return NextResponse.redirect(new URL("/?error=slack_state", env.appUrl));
  }
  const agent = await getAgent(db(), viewer.tenant.id, state.agentId);
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

  const owner = await findSlackInstall(db(), installed.teamId);
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
      token: installed.botToken,
      oauth: { accessToken: installed.botToken, scope: installed.scope },
      accountName: installed.teamName,
      externalKey: installed.teamId,
    },
  );
  try {
    await pushServicesToAgent(agent);
  } catch (e) {
    console.warn(`[slack] не удалось отдать токен на машину: ${e instanceof Error ? e.message : String(e)}`);
  }
  return NextResponse.redirect(new URL(`/agents/${agent.id}?slack=connected`, env.appUrl));
}
