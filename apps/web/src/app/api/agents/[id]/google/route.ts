import { NextResponse } from "next/server";
import { getAgent, googleRefreshTokenOf, updateAgent } from "@swarm/agents";
import { buildConsentUrl, revokeToken } from "@swarm/google";
import { encryptJson } from "@swarm/crypto";
import { env } from "@/env";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { awakeRuntime } from "@/lib/runtime-client";
import { t } from "@/i18n";

type Params = { params: Promise<{ id: string }> };

/** Отозвать доступ Google, удалить токен из базы и с машины агента. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const refreshToken = googleRefreshTokenOf(agent);
  if (refreshToken) {
    try {
      await revokeToken(refreshToken);
    } catch (error) {
      console.warn(`[google] revoke: ${String(error)}`);
      return NextResponse.json({ error: t("errors.googleRevoke") }, { status: 502 });
    }
  }

  await updateAgent(db(), agent.id, { googleRefreshToken: null, googleEmail: null });

  try {
    const client = await awakeRuntime(agent);
    await client?.deleteGoogleToken();
  } catch (error) {
    // Токен уже отозван у Google, поэтому оставшаяся на машине копия не даёт доступа.
    console.warn(`[google] delete token from runtime: ${String(error)}`);
  }

  return NextResponse.json({ ok: true });
}

/** Кнопка «Подключить Google»: уводит на согласие, state несёт agentId и tenantId. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/login", env.appUrl));
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const clientId = env.google.clientId;
  const clientSecret = env.google.clientSecret;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`/agents/${id}?error=google_not_configured`, env.appUrl));
  }
  const state = encryptJson({ agentId: agent.id, tenantId: viewer.tenant.id, at: Date.now() });
  const url = buildConsentUrl(
    { clientId, clientSecret, redirectUri: `${env.appUrl}/api/google/callback` },
    state,
  );
  return NextResponse.redirect(url);
}
