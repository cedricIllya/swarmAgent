import { after, NextResponse } from "next/server";
import { findSlackInstall } from "@swarm/connections";
import { env } from "@/env";
import { db } from "@/lib/db";
import { parseSlackEnvelope, verifySlackSignature } from "@/lib/slack";
import { acceptSlack, disconnectSlackTeam } from "@/lib/slack-delivery";

/**
 * Events API Slack. Подпись проверяется до разбора.
 * url_verification отвечает challenge сразу, событие уходит агенту после ответа.
 */
export async function POST(req: Request): Promise<Response> {
  const signingSecret = env.slack.signingSecret;
  if (!signingSecret) {
    console.warn("[webhooks/slack] нет SLACK_SIGNING_SECRET");
    return NextResponse.json({ error: "slack not configured" }, { status: 503 });
  }
  const raw = await req.text();
  const verdict = verifySlackSignature({
    signingSecret,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    rawBody: raw,
  });
  if (!verdict.ok) {
    console.warn(`[webhooks/slack] отклонено: ${verdict.reason}`);
    return NextResponse.json({ error: verdict.reason }, { status: 401 });
  }

  const notice = parseSlackEnvelope(raw);
  if (notice.kind === "challenge") return NextResponse.json({ challenge: notice.challenge });
  if (notice.kind === "ignore") return NextResponse.json({ ok: true });

  after(async () => {
    if (notice.kind === "uninstall") {
      await disconnectSlackTeam(notice.teamId);
      return;
    }
    const install = await findSlackInstall(db(), notice.event.teamId);
    if (!install) {
      console.warn(`[webhooks/slack] нет агента для команды ${notice.event.teamId}`);
      return;
    }
    await acceptSlack(install.agentId, notice.event);
  });
  return NextResponse.json({ ok: true });
}
