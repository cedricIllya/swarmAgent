import { after, NextResponse } from "next/server";
import { authorizeInbound, normalizeJson, normalizeMailgunForm, parseAddress } from "@swarm/mail";
import { findAgentByAddress } from "@swarm/agents";
import { env } from "@/env";
import { db } from "@/lib/db";
import { RuntimeClient } from "@/lib/runtime-client";

/**
 * Единственный URL, который видит Mailgun. Отвечает 200 сразу, работает после ответа.
 * Два формата входа: form-urlencoded (Mailgun Routes) и JSON (Postmark и подобные).
 */
export async function POST(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  const presentedToken =
    req.headers.get("x-webhook-token") ??
    (req.headers.get("authorization")?.startsWith("Bearer ") ? req.headers.get("authorization")!.slice(7) : undefined);

  let format: "form" | "json";
  let form: Record<string, string> | null = null;
  let json: Record<string, unknown> | null = null;

  if (contentType.includes("application/json")) {
    format = "json";
    json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "bad json" }, { status: 400 });
  } else {
    format = "form";
    const fd = await req.formData().catch(() => null);
    if (!fd) return NextResponse.json({ error: "bad form" }, { status: 400 });
    form = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string" && !(k in form)) form[k] = v;
  }

  const mailgunSig =
    form && form["timestamp"] && form["token"] && form["signature"]
      ? { timestamp: form["timestamp"], token: form["token"], signature: form["signature"] }
      : undefined;

  const verdict = authorizeInbound(
    { mailgunSigningKey: env.mailgun.signingKey, inboundToken: env.inboundWebhookToken },
    { format, mailgun: mailgunSig, presentedToken: presentedToken ?? undefined },
  );
  if (!verdict.ok) {
    console.warn(`[webhooks/email] отклонено: ${verdict.reason}`);
    return NextResponse.json({ error: verdict.reason }, { status: verdict.status });
  }
  if (verdict.mode === "open") {
    console.warn("[webhooks/email] ВХОД БЕЗ ПРОВЕРКИ: нет MAILGUN_SIGNING_KEY и INBOUND_WEBHOOK_TOKEN. Только для разработки.");
  }

  const email = format === "form" ? normalizeMailgunForm(form!) : normalizeJson(json!);

  after(async () => {
    const addr = parseAddress(email.to);
    if (!addr) {
      console.warn(`[webhooks/email] не разобрать адрес получателя: ${email.to}`);
      return;
    }
    const agent = await findAgentByAddress(db(), addr.localPart, addr.domain);
    if (!agent) {
      console.warn(`[webhooks/email] нет агента для ${addr.localPart}@${addr.domain}; письмо не обработано`);
      return;
    }
    const client = RuntimeClient.for(agent);
    if (!client || agent.status !== "running") {
      console.warn(`[webhooks/email] агент ${agent.id} не запущен (${agent.status}); письмо не доставлено`);
      return;
    }
    try {
      await client.deliverEmail({ email });
    } catch (e) {
      console.error(`[webhooks/email] доставка в runtime ${agent.id} упала: ${String(e)}`);
    }
  });

  return NextResponse.json({ ok: true });
}
