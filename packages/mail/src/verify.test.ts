import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeInbound } from "./verify";

const KEY = "signing-key";
const NOW = 1_700_000_000_000;

function sign(ts: number, token = "tok") {
  const timestamp = String(ts);
  const signature = createHmac("sha256", KEY).update(timestamp + token).digest("hex");
  return { timestamp, token, signature };
}

describe("authorizeInbound", () => {
  it("accepts a fresh mailgun signature when only key is set", () => {
    const r = authorizeInbound(
      { mailgunSigningKey: KEY, now: () => NOW },
      { format: "form", mailgun: sign(NOW / 1000) },
    );
    expect(r).toEqual({ ok: true, mode: "mailgun" });
  });

  it("rejects an old signature", () => {
    const r = authorizeInbound(
      { mailgunSigningKey: KEY, now: () => NOW },
      { format: "form", mailgun: sign(NOW / 1000 - 600) },
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a bad signature", () => {
    const s = sign(NOW / 1000);
    s.signature = "00" + s.signature.slice(2);
    const r = authorizeInbound({ mailgunSigningKey: KEY, now: () => NOW }, { format: "form", mailgun: s });
    expect(r.ok).toBe(false);
  });

  it("closes JSON when only key is set", () => {
    const r = authorizeInbound({ mailgunSigningKey: KEY }, { format: "json", presentedToken: "x" });
    expect(r.ok).toBe(false);
  });

  it("requires token on both formats when only token is set", () => {
    const cfg = { inboundToken: "секрет" };
    expect(authorizeInbound(cfg, { format: "form" }).ok).toBe(false);
    expect(authorizeInbound(cfg, { format: "json", presentedToken: "секрет" }).ok).toBe(true);
    expect(authorizeInbound(cfg, { format: "form", presentedToken: "секрет" }).ok).toBe(true);
    expect(authorizeInbound(cfg, { format: "json", presentedToken: "секре" }).ok).toBe(false);
  });

  it("requires both token and signature on form when both are set", () => {
    const cfg = { inboundToken: "t", mailgunSigningKey: KEY, now: () => NOW };
    expect(authorizeInbound(cfg, { format: "form", presentedToken: "t" }).ok).toBe(false);
    expect(
      authorizeInbound(cfg, { format: "form", presentedToken: "t", mailgun: sign(NOW / 1000) }),
    ).toEqual({ ok: true, mode: "mailgun" });
  });

  it("is open when nothing is configured", () => {
    expect(authorizeInbound({}, { format: "json" })).toEqual({ ok: true, mode: "open" });
  });
});
