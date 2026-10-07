import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { encryptJson } from "@swarm/crypto";
import { env } from "@/env";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { buildSlackConsentUrl, slackRedirectUri } from "@/lib/slack";

/** Кнопка «Подключить Slack»: уводит на согласие, state несёт agentId и tenantId. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.redirect(new URL("/login", env.appUrl));
  const { id } = await params;
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  const clientId = env.slack.clientId;
  const clientSecret = env.slack.clientSecret;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`/agents/${id}?error=slack_not_configured`, env.appUrl));
  }
  const state = encryptJson({ agentId: agent.id, tenantId: viewer.tenant.id, at: Date.now() });
  const url = buildSlackConsentUrl(
    { clientId, clientSecret, redirectUri: slackRedirectUri(env.appUrl) },
    state,
  );
  return NextResponse.redirect(url);
}
