import { NextResponse } from "next/server";
import { encryptJson } from "@swarm/crypto";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { env } from "@/env";
import { buildSlackConsentUrl, slackRedirectUri } from "@/lib/slack";

/**
 * Агент уже вошёл в Slack своим аккаунтом и просит страницу разрешения.
 * Кнопки в интерфейсе нет: ссылку открывает его браузер.
 */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const clientId = env.slack.clientId;
  const clientSecret = env.slack.clientSecret;
  if (!clientId || !clientSecret) return NextResponse.json({ error: "slack not configured" }, { status: 503 });
  const state = encryptJson({ agentId: agent.id, tenantId: agent.tenantId, at: Date.now() });
  const url = buildSlackConsentUrl({ clientId, clientSecret, redirectUri: slackRedirectUri(env.appUrl) }, state);
  return NextResponse.json({ url });
}
