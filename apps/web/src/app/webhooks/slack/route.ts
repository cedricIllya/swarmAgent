import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { parseSlackEnvelope, verifySlackSignature } from "@/lib/slack";
import { acceptSlack, disconnectSlackTeam, disconnectSlackUser, slackRecipients } from "@/lib/slack-delivery";

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
      if (notice.userIds.length === 0) await disconnectSlackTeam(notice.teamId);
      else for (const userId of notice.userIds) await disconnectSlackUser(userId);
      return;
    }
    const installs = await slackRecipients(notice.userIds, notice.event.teamId);
    if (installs.length === 0) {
      console.warn(`[webhooks/slack] нет агента для ${notice.userIds.join(",") || notice.event.teamId}`);
      return;
    }
    for (const install of installs) await acceptSlack(install.agentId, notice.event);
  });
  return NextResponse.json({ ok: true });
}
