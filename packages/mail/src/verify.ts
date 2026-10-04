import { createHmac, timingSafeEqual } from "node:crypto";

export interface InboundAuthConfig {
  mailgunSigningKey?: string | undefined;
  inboundToken?: string | undefined;
  now?: () => number;
}

export type InboundFormat = "form" | "json";

export interface InboundAuthInput {
  format: InboundFormat;
  /** Mailgun: timestamp, token, signature из тела формы. */
  mailgun?: { timestamp: string; token: string; signature: string } | undefined;
  /** X-Webhook-Token или Authorization: Bearer. */
  presentedToken?: string | undefined;
}

export type InboundAuthResult =
  | { ok: true; mode: "mailgun" | "token" | "open" }
  | { ok: false; status: 403; reason: string };

const FIVE_MINUTES = 5 * 60;

function bytesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyMailgunSignature(
  key: string,
  sig: { timestamp: string; token: string; signature: string },
  now = Date.now,
): { ok: true } | { ok: false; reason: string } {
  const ts = Number(sig.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp не число" };
  const age = Math.abs(Math.floor(now() / 1000) - ts);
  if (age > FIVE_MINUTES) return { ok: false, reason: "подпись старше 5 минут" };
  const expected = createHmac("sha256", key).update(sig.timestamp + sig.token).digest("hex");
  if (!bytesEqual(expected, sig.signature.toLowerCase())) {
    return { ok: false, reason: "подпись не сходится" };
  }
  return { ok: true };
}

/**
 * Правило дверей:
 * - есть signing key и нет token → JSON отклоняем;
 * - есть только token → и form, и JSON требуют token;
 * - нет ничего → принимаем, вызывающий код громко логирует.
 */
export function authorizeInbound(cfg: InboundAuthConfig, input: InboundAuthInput): InboundAuthResult {
  const hasKey = Boolean(cfg.mailgunSigningKey);
  const hasToken = Boolean(cfg.inboundToken);

  if (!hasKey && !hasToken) return { ok: true, mode: "open" };

  if (hasToken) {
    if (!input.presentedToken || !bytesEqual(cfg.inboundToken as string, input.presentedToken)) {
      return { ok: false, status: 403, reason: "неверный webhook token" };
    }
    if (hasKey && input.format === "form") {
      if (!input.mailgun) return { ok: false, status: 403, reason: "нет подписи Mailgun" };
      const v = verifyMailgunSignature(cfg.mailgunSigningKey as string, input.mailgun, cfg.now);
      if (!v.ok) return { ok: false, status: 403, reason: v.reason };
      return { ok: true, mode: "mailgun" };
    }
    return { ok: true, mode: "token" };
  }

  if (input.format === "json") {
    return { ok: false, status: 403, reason: "JSON-вход без INBOUND_WEBHOOK_TOKEN закрыт" };
  }
  if (!input.mailgun) return { ok: false, status: 403, reason: "нет подписи Mailgun" };
  const v = verifyMailgunSignature(cfg.mailgunSigningKey as string, input.mailgun, cfg.now);
  if (!v.ok) return { ok: false, status: 403, reason: v.reason };
  return { ok: true, mode: "mailgun" };
}
