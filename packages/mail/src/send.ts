import type { OutboundEmail } from "@swarm/contracts";

export interface MailgunSender {
  apiKey: string;
  region: "us" | "eu";
  domain: string;
  fetchImpl?: typeof fetch;
}

export function mailgunBase(region: "us" | "eu"): string {
  return region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
}

/**
 * Отправка через Mailgun API с адреса агента. Возвращает Message-ID
 * в угловых скобках, чтобы потом узнать ответ в ветке.
 */
export async function sendViaMailgun(
  cfg: MailgunSender,
  fromAddress: string,
  mail: OutboundEmail,
): Promise<{ messageId: string }> {
  const form = new FormData();
  form.set("from", fromAddress);
  form.set("to", mail.to);
  form.set("subject", mail.subject);
  form.set("text", mail.text);
  if (mail.html) form.set("html", mail.html);
  if (mail.inReplyTo) form.set("h:In-Reply-To", mail.inReplyTo);
  if (mail.references?.length) form.set("h:References", mail.references.join(" "));

  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`${mailgunBase(cfg.region)}/v3/${cfg.domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`api:${cfg.apiKey}`).toString("base64"),
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Mailgun send failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id?: string };
  const id = json.id ?? `<${crypto.randomUUID()}@${cfg.domain}>`;
  return { messageId: id.startsWith("<") ? id : `<${id}>` };
}
