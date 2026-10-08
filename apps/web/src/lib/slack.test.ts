import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeSlackChoice } from "@swarm/contracts";
import { buildSlackConsentUrl, exchangeSlackCode, parseSlackEnvelope, parseSlackInteraction, verifySlackSignature } from "./slack";

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
      userIds: [],
    });
    expect(
      parseSlackEnvelope(
        JSON.stringify({
          type: "event_callback",
          team_id: "T1",
          event: { type: "tokens_revoked", tokens: { oauth: ["U9"], bot: [] } },
        }),
      ),
    ).toEqual({ kind: "uninstall", teamId: "T1", userIds: ["U9"] });
  });

  it("зовёт агента, которому видно событие, и того, кого упомянули", () => {
    const notice = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev3",
        authorizations: [{ user_id: "UAGENT" }],
        event: { type: "message", channel: "C1", channel_type: "channel", user: "UHUMAN", text: "посмотри <@UOTHER> отчёт", ts: "1.4" },
      }),
    );
    expect(notice).toMatchObject({ kind: "message", userIds: ["UAGENT", "UOTHER"] });
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

describe("buildSlackConsentUrl", () => {
  it("просит права пользователя и бота, которым уходят кнопки", () => {
    const url = new URL(
      buildSlackConsentUrl({ clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/api/slack/callback" }, "state"),
    );
    expect(url.searchParams.get("user_scope")).toContain("chat:write");
    expect(url.searchParams.get("user_scope")).toContain("im:history");
    expect(url.searchParams.get("scope")).toContain("chat:write");
    expect(url.searchParams.get("scope")).toContain("chat:write.public");
  });
});

describe("exchangeSlackCode", () => {
  it("берёт user token и имя того, кто подтвердил доступ", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const href = String(url);
      if (href.includes("users.info")) {
        return new Response(JSON.stringify({ ok: true, user: { real_name: "Ада", profile: { display_name: "Ада" } } }));
      }
      return new Response(
        JSON.stringify({
          ok: true,
          authed_user: { id: "U9", access_token: "xoxp-1", scope: "chat:write,im:history" },
          team: { id: "T9", name: "Acme" },
        }),
        { status: 200 },
      );
    });
    const installed = await exchangeSlackCode(
      { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/api/slack/callback", fetchImpl },
      "code",
    );
    expect(installed).toMatchObject({ userToken: "xoxp-1", userId: "U9", teamId: "T9", teamName: "Acme", displayName: "Ада" });
    expect(installed.botToken).toBeUndefined();
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}` });
  });

  it("сохраняет токен бота, если Slack его отдал", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("users.info")) {
        return new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Ада" } } }));
      }
      return new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-bot",
          bot_user_id: "UBOT",
          authed_user: { id: "U9", access_token: "xoxp-1", scope: "chat:write" },
          team: { id: "T9", name: "Acme" },
        }),
      );
    });
    const installed = await exchangeSlackCode(
      { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/cb", fetchImpl },
      "code",
    );
    expect(installed.botToken).toBe("xoxb-bot");
    expect(installed.botUserId).toBe("UBOT");
  });

  it("не принимает ответ без ok", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_code" })));
    await expect(
      exchangeSlackCode({ clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/cb", fetchImpl }, "code"),
    ).rejects.toThrow("invalid_code");
  });
});

describe("parseSlackInteraction", () => {
  it("читает нажатую кнопку и отбрасывает чужой адрес обновления", () => {
    const value = encodeSlackChoice({ agentId: "agt_1", approvalId: "qst_1", index: 1 });
    const payload = {
      type: "block_actions",
      response_url: "https://hooks.slack.com/actions/T/B/x",
      message: { text: "Какой срок?" },
      actions: [{ action_id: "swarm_choice_1", value, text: { type: "plain_text", text: "На неделе" } }],
    };
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(payload) }).toString())).toEqual({
      agentId: "agt_1",
      approvalId: "qst_1",
      index: 1,
      label: "На неделе",
      responseUrl: "https://hooks.slack.com/actions/T/B/x",
      prompt: "Какой срок?",
    });

    const foreign = { ...payload, response_url: "https://evil.example/hook" };
    expect(parseSlackInteraction(new URLSearchParams({ payload: JSON.stringify(foreign) }).toString())?.responseUrl).toBe("");
    expect(parseSlackInteraction("payload=" + encodeURIComponent(JSON.stringify({ type: "view_submission" })))).toBeNull();
  });
});
