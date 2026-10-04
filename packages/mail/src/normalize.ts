import type { InboundEmail } from "@swarm/contracts";

type Headers = Record<string, string>;

function lowerFirst(pairs: Iterable<[string, string]>): Headers {
  const out: Headers = {};
  for (const [k, v] of pairs) {
    const key = k.toLowerCase();
    if (!(key in out)) out[key] = v;
  }
  return out;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

export function extractMessageIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const ids = raw.match(/<[^<>\s]+>/g) ?? [];
  return ids.slice(-20);
}

export function extractDkimDomains(all: Array<[string, string]>): string[] {
  const out = new Set<string>();
  for (const [k, v] of all) {
    if (k.toLowerCase() !== "dkim-signature") continue;
    const m = v.match(/(?:^|;)\s*d=([^;\s]+)/i);
    if (m?.[1]) out.add(m[1].toLowerCase());
  }
  return [...out];
}

/** Текст и ссылки из HTML без скриптов и стилей. */
export function htmlToText(html: string): { text: string; links: string[] } {
  if (!html) return { text: "", links: [] };
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  const links: string[] = [];
  const seen = new Set<string>();
  for (const m of noScripts.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!href || href.startsWith("#") || /^mailto:/i.test(href) || /^javascript:/i.test(href)) continue;
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }

  const text = decodeEntities(
    noScripts
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, links };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** Тело без цитаты предыдущих писем. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (
      t.startsWith(">") ||
      /^On .+ wrote:$/i.test(t) ||
      /^(\d{1,2}[./]\d{1,2}[./]\d{2,4}|пн|вт|ср|чт|пт|сб|вс),?.*написал/i.test(t) ||
      /^-{2,}\s*(Original Message|Пересылаемое сообщение)/i.test(t) ||
      /^From:\s/.test(t) ||
      /^От:\s/.test(t) ||
      t === "--" ||
      t === "-- "
    ) {
      break;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Нужны ли поля вердиктов из Mailgun. */
function verdict(headers: Headers, key: string): string | null {
  const v = headers[key.toLowerCase()];
  return v ? v.toLowerCase() : null;
}

function build(args: {
  sender: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  pairs: Array<[string, string]>;
  replyText?: string | undefined;
  messageId?: string | undefined;
}): InboundEmail {
  const headers = lowerFirst(args.pairs);
  const fromHtml = htmlToText(args.html);
  const text = args.text || fromHtml.text;
  const messageId =
    extractMessageIds(args.messageId ?? headers["message-id"])[0] ??
    (args.messageId ? `<${args.messageId.replace(/^<|>$/g, "")}>` : null);
  return {
    sender: args.sender || args.from,
    from: args.from,
    to: args.to,
    subject: args.subject,
    text,
    html: args.html,
    headers,
    messageId,
    inReplyTo: extractMessageIds(headers["in-reply-to"])[0] ?? null,
    references: extractMessageIds(headers["references"]),
    dkimDomains: extractDkimDomains(args.pairs),
    replyText: args.replyText && args.replyText.length > 0 ? args.replyText : stripQuotedReply(text),
    links: fromHtml.links,
    spf: verdict(headers, "X-Mailgun-Spf"),
    dkim: verdict(headers, "X-Mailgun-Dkim-Check-Result"),
    receivedAt: new Date().toISOString(),
  };
}

/** Mailgun Routes форма: `message-headers` — JSON-список пар. */
export function normalizeMailgunForm(form: Record<string, string>): InboundEmail {
  let pairs: Array<[string, string]> = [];
  const rawHeaders = form["message-headers"];
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders) as unknown;
      if (Array.isArray(parsed)) {
        pairs = parsed
          .filter((p): p is [unknown, unknown] => Array.isArray(p) && p.length >= 2)
          .map(([k, v]) => [String(k), String(v)]);
      }
    } catch {
      pairs = [];
    }
  }
  for (const k of ["X-Mailgun-Spf", "X-Mailgun-Dkim-Check-Result", "Message-Id", "In-Reply-To", "References"]) {
    const v = form[k];
    if (v && !pairs.some(([pk]) => pk.toLowerCase() === k.toLowerCase())) pairs.push([k, v]);
  }
  return build({
    sender: pick(form, "sender"),
    from: pick(form, "from", "From", "sender"),
    to: pick(form, "recipient", "to", "To"),
    subject: pick(form, "subject", "Subject"),
    text: pick(form, "body-plain", "stripped-text"),
    html: pick(form, "body-html", "stripped-html"),
    pairs,
    replyText: pick(form, "stripped-text") || undefined,
  });
}

/** JSON как у Postmark: `Headers` — список `{Name, Value}`. */
export function normalizeJson(body: Record<string, unknown>): InboundEmail {
  const headersRaw = body["Headers"] ?? body["headers"];
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(headersRaw)) {
    for (const h of headersRaw) {
      if (h && typeof h === "object") {
        const o = h as Record<string, unknown>;
        const name = o["Name"] ?? o["name"];
        const value = o["Value"] ?? o["value"];
        if (typeof name === "string" && typeof value === "string") pairs.push([name, value]);
      }
    }
  } else if (headersRaw && typeof headersRaw === "object") {
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (typeof v === "string") pairs.push([k, v]);
    }
  }
  const fromFull = pick(body, "FromFull") as unknown;
  const from =
    pick(body, "From", "from") ||
    (fromFull && typeof fromFull === "object" ? String((fromFull as Record<string, unknown>)["Email"] ?? "") : "");
  return build({
    sender: pick(body, "MailFrom", "sender", "ReturnPath") || from,
    from,
    to: pick(body, "OriginalRecipient", "To", "to"),
    subject: pick(body, "Subject", "subject"),
    text: pick(body, "TextBody", "text"),
    html: pick(body, "HtmlBody", "html"),
    pairs,
    replyText: pick(body, "StrippedTextReply") || undefined,
    messageId: pick(body, "MessageID", "MessageId", "messageId") || undefined,
  });
}
