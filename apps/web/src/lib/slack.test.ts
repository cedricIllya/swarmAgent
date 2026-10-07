import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { exchangeSlackCode, parseSlackEnvelope, verifySlackSignature } from "./slack";

const secret = "8f742231b10e8888abcd99yyyzzz85a5";

function sign(timestamp: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  it("принимает свежую подпись и отклоняет чужую и старую", () => {
    const body = '{"type":"url_verification","challenge":"abc"}';
    const now = 1_531_420_618_000;
    const timestamp = "1531420618";
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp, signature: sign(timestamp, body), rawBody: body, now }),
    ).toEqual({ ok: true });
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature: sign(timestamp, body + " "),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: "подпись не сходится" });
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: "1531420000",
        signature: sign("1531420000", body),
        rawBody: body,
        now,
      }),
    ).toEqual({ ok: false, reason: "подпись старше 5 минут" });
  });
});

describe("parseSlackEnvelope", () => {
  it("отдаёт challenge, личку и снятие установки", () => {
    expect(parseSlackEnvelope(JSON.stringify({ type: "url_verification", challenge: "ch" }))).toEqual({
      kind: "challenge",
      challenge: "ch",
    });
    expect(
      parseSlackEnvelope(
        JSON.stringify({
          type: "event_callback",
          team_id: "T1",
          event_id: "Ev1",
          event: { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "привет", ts: "1.2" },
        }),
      ),
    ).toMatchObject({ kind: "message", event: { eventId: "Ev1", teamId: "T1", event: { type: "message", text: "привет" } } });
    expect(parseSlackEnvelope(JSON.stringify({ type: "event_callback", team_id: "T1", event: { type: "app_uninstalled" } }))).toEqual({
      kind: "uninstall",
      teamId: "T1",
    });
  });

  it("не будит агента из-за своего сообщения", () => {
    expect(
      parseSlackEnvelope(
        JSON.stringify({
          type: "event_callback",
          team_id: "T1",
          event_id: "Ev2",
          event: { type: "message", channel: "D1", user: "UBOT", bot_id: "B1", text: "я сам", ts: "1.3" },
        }),
      ),
    ).toEqual({ kind: "ignore" });
  });
});

describe("exchangeSlackCode", () => {
  it("берёт bot token и команду из oauth.v2.access", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-1",
          scope: "chat:write",
          team: { id: "T9", name: "Acme" },
        }),
      ),
    );
    const installed = await exchangeSlackCode(
      { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/api/slack/callback", fetchImpl },
      "code",
    );
    expect(installed).toMatchObject({ botToken: "xoxb-1", teamId: "T9", teamName: "Acme" });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}` });
  });

  it("не принимает ответ без ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_code" })));
    await expect(
      exchangeSlackCode({ clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/cb", fetchImpl }, "code"),
    ).rejects.toThrow("invalid_code");
  });
});
