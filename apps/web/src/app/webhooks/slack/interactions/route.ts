import { after, NextResponse } from "next/server";
import { env } from "@/env";
import { acceptSlackChoice } from "@/lib/slack-delivery";
import { parseSlackInteraction, verifySlackSignature } from "@/lib/slack";

/**
 * Нажатие кнопки вариантов. Подпись та же, что у Events API.
 * Тело — form, поле `payload`. Ответ уходит сразу: машина может просыпаться дольше,
 * чем Slack ждёт этот запрос.
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

  const choice = parseSlackInteraction(raw);
  if (!choice) return NextResponse.json({ ok: true });
  after(async () => {
    await acceptSlackChoice(choice);
  });
  return NextResponse.json({ ok: true });
}
