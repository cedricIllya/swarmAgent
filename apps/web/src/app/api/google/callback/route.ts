import { NextResponse } from "next/server";
import { exchangeCode, toGoogleTokenJson } from "@swarm/google";
import { getAgent, updateAgent } from "@swarm/agents";
import { decryptJson } from "@swarm/crypto";
import { env } from "@/env";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";

/** Callback Google: refresh token в базу (шифрованно) и google_token.json на машину агента. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/login", env.appUrl));
  if (!code || !stateRaw) return NextResponse.redirect(new URL("/?error=google_denied", env.appUrl));

  let state: { agentId: string; tenantId: string; at: number };
  try {
    state = decryptJson(stateRaw);
  } catch {
    return NextResponse.redirect(new URL("/?error=google_state", env.appUrl));
  }
  if (state.tenantId !== viewer.tenant.id || Date.now() - state.at > 15 * 60 * 1000) {
    return NextResponse.redirect(new URL("/?error=google_state", env.appUrl));
  }
  const agent = await getAgent(db(), viewer.tenant.id, state.agentId);
  if (!agent) return NextResponse.redirect(new URL("/?error=agent_missing", env.appUrl));

  const clientId = env.google.clientId!;
  const clientSecret = env.google.clientSecret!;
  const cfg = { clientId, clientSecret, redirectUri: `${env.appUrl}/api/google/callback` };
  const tokens = await exchangeCode(cfg, code);
  if (!tokens.refreshToken) {
    return NextResponse.redirect(new URL(`/agents/${agent.id}?error=google_no_refresh`, env.appUrl));
  }

  await updateAgent(db(), agent.id, { googleRefreshToken: tokens.refreshToken, googleEmail: tokens.email });

  const client = await awakeRuntime(agent);
  if (client) {
    try {
      await client.googleToken({
        token: toGoogleTokenJson(cfg, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
        }),
      });
    } catch (e) {
      console.warn(`[google] не удалось положить токен на машину: ${String(e)}`);
    }
  }
  return NextResponse.redirect(new URL(`/agents/${agent.id}?google=connected`, env.appUrl));
}
