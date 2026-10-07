import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliverSlackEventRequest, ServiceRecipe } from "@swarm/contracts";

/**
 * Бот Slack для агента. События приходят на `{APP_URL}/webhooks/slack`,
 * установка — на `{APP_URL}/api/slack/callback`.
 * Права покрывают личные сообщения, упоминания и запасной опрос истории.
 */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

const FIVE_MINUTES = 5 * 60;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function slackRedirectUri(appUrl: string): string {
  return `${appUrl}/api/slack/callback`;
}

export function buildSlackConsentUrl(cfg: SlackOAuthConfig, state: string): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export function slackServiceRecipe(): ServiceRecipe {
  return {
    slug: "slack",
    name: "Slack",
    kind: "api",
    domains: ["slack.com"],
    api: { baseUrl: "https://slack.com/api", auth: "bearer", authHeader: "Authorization" },
    notes: "",
    watchesTasks: false,
    channel: "messenger",
    discoveredBy: null,
  };
}

export interface SlackInstall {
  botToken: string;
  scope: string;
  teamId: string;
  teamName: string;
}

/** Код установки меняется на bot token. `ok: false` — ошибка Slack, не HTTP. */
export async function exchangeSlackCode(cfg: SlackOAuthConfig, code: string): Promise<SlackInstall> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetchImpl("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code, redirect_uri: cfg.redirectUri }),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    scope?: string;
    team?: { id?: string; name?: string };
  } | null;
  if (!res.ok || !data?.ok || !data.access_token || !data.team?.id) {
    throw new Error(data?.error || `slack oauth ${res.status}`);
  }
  return {
    botToken: data.access_token,
    scope: data.scope ?? SLACK_BOT_SCOPES.join(","),
    teamId: data.team.id,
    teamName: data.team.name?.trim() || data.team.id,
  };
}

/** `team_id` из auth.test. Пусто — токен не от Web API. */
export async function slackTeamId(token: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json()) as { ok?: boolean; team_id?: string };
    return data.ok && data.team_id ? data.team_id : null;
  } catch {
    return null;
  }
}

function bytesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Подпись Slack: `v0=` + HMAC-SHA256(`v0:timestamp:body`). Старше пяти минут не принимается. */
export function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const now = args.now ?? Date.now();
  if (!args.timestamp || !args.signature) return { ok: false, reason: "нет подписи" };
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "timestamp не число" };
  if (Math.abs(Math.floor(now / 1000) - ts) > FIVE_MINUTES) return { ok: false, reason: "подпись старше 5 минут" };
  const expected =
    "v0=" + createHmac("sha256", args.signingSecret).update(`v0:${args.timestamp}:${args.rawBody}`).digest("hex");
  if (!bytesEqual(expected, args.signature)) return { ok: false, reason: "подпись не сходится" };
  return { ok: true };
}

export type SlackNotice =
  | { kind: "challenge"; challenge: string }
  | { kind: "uninstall"; teamId: string }
  | { kind: "message"; event: DeliverSlackEventRequest }
  | { kind: "ignore" };

/** Что делать с телом Events API. Свои сообщения бота сюда не доходят — машину из-за них не будим. */
export function parseSlackEnvelope(raw: string): SlackNotice {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (!body || typeof body !== "object") return { kind: "ignore" };
  const envelope = body as Record<string, unknown>;
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    const challenge = envelope.challenge;
    if (!challenge || challenge.length > 1024) return { kind: "ignore" };
    return { kind: "challenge", challenge };
  }
  if (envelope.type !== "event_callback") return { kind: "ignore" };
  const teamId = typeof envelope.team_id === "string" ? envelope.team_id : "";
  const event = envelope.event;
  if (!teamId || !event || typeof event !== "object") return { kind: "ignore" };
  const ev = event as Record<string, unknown>;
  if (ev.type === "app_uninstalled" || ev.type === "tokens_revoked") return { kind: "uninstall", teamId };
  if (ev.type !== "message" && ev.type !== "app_mention") return { kind: "ignore" };
  if (typeof ev.bot_id === "string" || typeof ev.subtype === "string") return { kind: "ignore" };
  if (typeof ev.user !== "string" || typeof ev.channel !== "string" || typeof ev.ts !== "string") return { kind: "ignore" };
  const text = typeof ev.text === "string" ? ev.text.trim() : "";
  if (!text) return { kind: "ignore" };
  const eventId = typeof envelope.event_id === "string" ? envelope.event_id : "";
  if (!eventId) return { kind: "ignore" };
  return {
    kind: "message",
    event: {
      eventId,
      teamId,
      event: {
        type: ev.type,
        channel: ev.channel,
        user: ev.user,
        text: text.slice(0, 8000),
        ts: ev.ts,
        ...(typeof ev.thread_ts === "string" ? { threadTs: ev.thread_ts } : {}),
        ...(typeof ev.channel_type === "string" ? { channelType: ev.channel_type } : {}),
      },
    },
  };
}
