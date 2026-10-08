import type { ChatMessage, DeliverSlackEventRequest, ServiceCredential, ServiceRecipe } from "@swarm/contracts";
import { messengerAdapter, messengerPatch } from "@swarm/contracts";
import { readJson, writeJson } from "../store/files";
import type { ChannelLink } from "../store/chats";
import { handleChat } from "../tasks/chat";
import type { AgentRuntime } from "../runtime";
import { redactInternal } from "../core/redact";
import { warn } from "../core/log";
import {
  hearSlack,
  slackConversations,
  slackDisplayName,
  slackHistory,
  slackIdentity,
  slackPlainText,
  slackPost,
  slackReplies,
  type HeardSlack,
  type SlackIdentity,
  type SlackRawMessage,
} from "./slack";

interface ChannelState {
  seen: string[];
  /** Ключ `slug:channel` → ts Slack, с которого читать дальше. */
  cursors: Record<string, string>;
  names: Record<string, string>;
  /** slug рецепта → бот, чтобы не звать auth.test на каждое событие. */
  identities: Record<string, SlackIdentity>;
}

const EMPTY: ChannelState = { seen: [], cursors: {}, names: {}, identities: {} };
const FIRST_WINDOW_SEC = 20 * 60;
const MAX_SEEN = 400;
const MAX_PER_TICK = 20;

let writing = Promise.resolve();

/** Чтение и запись курсоров по очереди, чтобы ответ и опрос не затирали друг друга. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writing.then(fn, fn);
  writing = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function stateFile(rt: AgentRuntime): string | null {
  if (typeof rt.store?.dir !== "function") return null;
  return rt.store.dir("channel-inbox.json");
}

async function readState(rt: AgentRuntime): Promise<ChannelState> {
  const file = stateFile(rt);
  if (!file) return { ...EMPTY, cursors: {}, names: {} };
  const raw = await readJson<ChannelState | null>(file, null);
  return {
    seen: Array.isArray(raw?.seen) ? raw.seen : [],
    cursors: raw?.cursors && typeof raw.cursors === "object" ? raw.cursors : {},
    names: raw?.names && typeof raw.names === "object" ? raw.names : {},
    identities: raw?.identities && typeof raw.identities === "object" ? raw.identities : {},
  };
}

/** Склеивает курсоры и уже виденные id, чтобы опрос не затёр событие, пришедшее вебхуком. */
async function writeState(rt: AgentRuntime, state: ChannelState): Promise<void> {
  const file = stateFile(rt);
  if (!file) return;
  await exclusive(async () => {
    const disk = await readJson<ChannelState | null>(file, null);
    const seen = Array.isArray(disk?.seen) ? [...disk.seen] : [];
    for (const id of state.seen) if (!seen.includes(id)) seen.push(id);
    const cursors = { ...(disk?.cursors ?? {}) };
    for (const [key, value] of Object.entries(state.cursors)) {
      const prev = cursors[key];
      if (!prev || value > prev) cursors[key] = value;
    }
    await writeJson(file, {
      seen: seen.slice(-MAX_SEEN),
      cursors,
      names: { ...(disk?.names ?? {}), ...state.names },
      identities: { ...(disk?.identities ?? {}), ...state.identities },
    });
  });
}

/** `false` — это сообщение уже взято в работу. */
async function claimSeen(rt: AgentRuntime, id: string): Promise<boolean> {
  return exclusive(async () => {
    const state = await readState(rt);
    if (state.seen.includes(id)) return false;
    state.seen.push(id);
    state.seen = state.seen.slice(-MAX_SEEN);
    const file = stateFile(rt);
    if (file) await writeJson(file, state);
    return true;
  });
}

async function forgetSeen(rt: AgentRuntime, id: string): Promise<void> {
  await exclusive(async () => {
    const state = await readState(rt);
    state.seen = state.seen.filter((item) => item !== id);
    const file = stateFile(rt);
    if (file) await writeJson(file, state);
  });
}

function tokenOf(cred: ServiceCredential | undefined): string | null {
  if (!cred) return null;
  const token = cred.token || cred.oauth?.accessToken;
  return token?.trim() || null;
}

function slackNow(offsetSec = 0): string {
  return (Date.now() / 1000 - offsetSec).toFixed(6);
}

function textForMessenger(message: ChatMessage): string | null {
  if (message.role !== "agent" || message.kind === "browser") return null;
  const text = message.text.trim();
  if (!text) return null;
  if (message.kind === "approval") {
    if (message.options?.length) {
      const lines = message.options.map((option, i) => `${i + 1}. ${option}`);
      return `${text}\n\n${lines.join("\n")}\n\nОтветьте в этом диалоге текстом или номером.`;
    }
    return `${text}\n\nОтветьте в этом диалоге: «да» или «нет».`;
  }
  return text;
}

async function stamp(rt: AgentRuntime, recipe: ServiceRecipe): Promise<void> {
  if (!rt.services?.applyReport) return;
  const next = messengerPatch(recipe);
  if (next.channel === recipe.channel && next.watchesTasks === recipe.watchesTasks && next.notes === recipe.notes) return;
  try {
    await rt.services.applyReport({ type: "recipe", recipe: next }, { quiet: true });
  } catch (e) {
    warn("channel", "не записал канал", { slug: recipe.slug, error: String(e) });
  }
}

async function authorName(token: string, state: ChannelState, userId: string, fetchImpl: typeof fetch): Promise<string> {
  const known = state.names[userId];
  if (known) return known;
  const name = await slackDisplayName(token, userId, fetchImpl);
  state.names[userId] = name;
  return name;
}

async function openThread(rt: AgentRuntime, link: ChannelLink, title: string): Promise<string> {
  const existingId = await rt.store.chats.findByThread(link.threadKey);
  if (existingId) return existingId;
  const chat = await rt.store.chats.create(title, "channel");
  await rt.store.chats.bind(chat.id, link);
  return chat.id;
}

async function ingest(rt: AgentRuntime, slug: string, author: string, heard: HeardSlack, threadContext: string): Promise<void> {
  const link: ChannelLink = {
    adapter: "slack",
    slug,
    threadKey: heard.threadKey,
    channel: heard.channel,
    ...(heard.threadTs ? { threadTs: heard.threadTs } : {}),
  };
  const chatId = await openThread(rt, link, `Slack · ${author}`.slice(0, 80));
  await handleChat(rt, {
    chatId,
    message: heard.text,
    author,
    fromMessenger: true,
    ...(threadContext ? { threadContext } : {}),
  });
}

/** ts корней тредов этого канала, куда агента уже звали. */
async function followedThreads(rt: AgentRuntime, channelId: string): Promise<Set<string>> {
  if (typeof rt.store.chats?.channelLinks !== "function") return new Set();
  const links = await rt.store.chats.channelLinks();
  const roots = new Set<string>();
  for (const link of links) {
    if (link.adapter === "slack" && link.channel === channelId && link.threadTs) roots.add(link.threadTs);
  }
  return roots;
}

/** Реплики треда до текущего сообщения, чтобы ответ не требовал нового упоминания. */
async function threadContext(
  token: string,
  state: ChannelState,
  selfId: string,
  heard: HeardSlack,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (heard.im || !heard.threadTs) return "";
  const currentTs = heard.externalId.slice(heard.externalId.indexOf(":") + 1);
  let messages: SlackRawMessage[];
  try {
    messages = await slackReplies(token, heard.channel, heard.threadTs, fetchImpl);
  } catch (e) {
    warn("channel", "тред Slack не прочитан", { channel: heard.channel, error: String(e) });
    return "";
  }
  const lines: string[] = [];
  for (const message of messages) {
    if (!message.ts || message.ts === currentTs || message.subtype || message.bot_id || !message.user) continue;
    const text = slackPlainText(message.text ?? "");
    if (!text) continue;
    const name = message.user === selfId ? "Агент" : await authorName(token, state, message.user, fetchImpl);
    lines.push(`${name}: ${text}`);
  }
  return lines.slice(-20).join("\n").slice(0, 3500);
}

async function cachedIdentity(rt: AgentRuntime, slug: string, token: string): Promise<SlackIdentity | null> {
  const state = await readState(rt);
  const known = state.identities[slug];
  if (known?.userId && known.teamId) return known;
  const fresh = await slackIdentity(token, globalThis.fetch);
  if (!fresh) return null;
  state.identities[slug] = fresh;
  await writeState(rt, state);
  return fresh;
}

/** Id пользователя Slack пишется в доступ, чтобы webhook нашёл этого агента среди других в той же команде. */
async function rememberSlackUser(rt: AgentRuntime, cred: ServiceCredential, userId: string): Promise<void> {
  if (cred.externalKey === userId || !rt.services?.applyReport) return;
  try {
    await rt.services.applyReport(
      { type: "credential", credential: { slug: cred.slug, kind: cred.kind, externalKey: userId } },
      { quiet: true },
    );
  } catch (e) {
    warn("channel", "пользователя Slack не записал", { slug: cred.slug, error: String(e) });
  }
}

async function pullSlack(rt: AgentRuntime, recipe: ServiceRecipe, cred: ServiceCredential, token: string): Promise<number> {
  const fetchImpl = globalThis.fetch;
  const identity = await cachedIdentity(rt, recipe.slug, token);
  if (!identity) {
    warn("channel", "токен Slack не принимает auth.test, сообщения не читаются", { slug: recipe.slug });
    return 0;
  }
  await rememberSlackUser(rt, cred, identity.userId);
  const state = await readState(rt);
  const seen = new Set(state.seen);
  let heard = 0;
  let conversations;
  try {
    conversations = await slackConversations(token, fetchImpl);
  } catch (e) {
    warn("channel", "список разговоров Slack не прочитан", { slug: recipe.slug, error: String(e) });
    return 0;
  }
  for (const conversation of conversations) {
    if (heard >= MAX_PER_TICK) break;
    const cursorKey = `${recipe.slug}:${conversation.id}`;
    const oldest = state.cursors[cursorKey] ?? slackNow(FIRST_WINDOW_SEC);
    let messages;
    try {
      messages = await slackHistory(token, conversation.id, oldest, fetchImpl);
    } catch (e) {
      warn("channel", "история Slack не прочитана", { channel: conversation.id, error: String(e) });
      continue;
    }
    const roots = conversation.im ? new Set<string>() : await followedThreads(rt, conversation.id);
    const replies: SlackRawMessage[] = [];
    if (!conversation.im) {
      for (const threadTs of roots) {
        try {
          replies.push(...(await slackReplies(token, conversation.id, threadTs, fetchImpl)));
        } catch (e) {
          warn("channel", "тред Slack не прочитан", { channel: conversation.id, error: String(e) });
        }
      }
    }
    const historyTs = new Set(messages.flatMap((message) => (message.ts ? [message.ts] : [])));
    const queued = new Set<string>();
    const fresh = hearSlack({
      teamId: identity.teamId,
      selfId: identity.userId,
      channelId: conversation.id,
      im: conversation.im,
      messages: [...messages, ...replies],
      followedThreads: roots,
    })
      .filter((item) => {
        if (seen.has(item.externalId) || queued.has(item.externalId)) return false;
        queued.add(item.externalId);
        return true;
      })
      .sort((a, b) => a.externalId.localeCompare(b.externalId));
    let advanced = oldest;
    let stopped = false;
    for (const item of fresh) {
      if (heard >= MAX_PER_TICK) {
        stopped = true;
        break;
      }
      if (!(await claimSeen(rt, item.externalId))) {
        const ts = item.externalId.slice(item.externalId.indexOf(":") + 1);
        if (historyTs.has(ts) && ts > advanced) advanced = ts;
        continue;
      }
      seen.add(item.externalId);
      state.seen.push(item.externalId);
      heard += 1;
      const ts = item.externalId.slice(item.externalId.indexOf(":") + 1);
      if (historyTs.has(ts) && ts > advanced) advanced = ts;
      try {
        const name = await authorName(token, state, item.authorId, fetchImpl);
        const context = await threadContext(token, state, identity.userId, item, fetchImpl);
        await ingest(rt, recipe.slug, name, item, context);
      } catch (e) {
        warn("channel", "сообщение Slack не принято", { id: item.externalId, error: String(e) });
      }
    }
    if (!stopped) {
      for (const message of messages) {
        if (message.ts && message.ts > advanced) advanced = message.ts;
      }
      if (messages.length === 0 && !state.cursors[cursorKey]) advanced = slackNow();
    }
    state.cursors[cursorKey] = advanced;
  }
  await writeState(rt, state);
  return heard;
}

/**
 * Подключённые мессенджеры. Slack с рабочим токеном читается сам.
 * Новое сообщение становится задачей в том же чате, ответ уходит обратно.
 */
export async function listenMessengers(rt: AgentRuntime): Promise<number> {
  if (typeof rt.store?.readServices !== "function") return 0;
  const services = await rt.store.readServices();
  if (!services || typeof rt.store.dir !== "function" || typeof rt.store.chats?.create !== "function") return 0;
  let heard = 0;
  for (const recipe of services.recipes) {
    const cred = services.credentials.find((item) => item.slug === recipe.slug);
    if (!cred || messengerPatch(recipe).channel !== "messenger") continue;
    await stamp(rt, recipe);
    if (messengerAdapter(recipe) !== "slack") continue;
    const token = tokenOf(cred);
    if (!token) continue;
    try {
      heard += await pullSlack(rt, recipe, cred, token);
    } catch (e) {
      warn("channel", "Slack не прочитан", { slug: recipe.slug, error: String(e) });
    }
  }
  return heard;
}

export type SlackAccept = "accepted" | "duplicate" | "ignored" | "unavailable";

/**
 * Событие Events API. Личка и упоминание становятся той же задачей, что и опрос.
 * Повтор Slack с тем же ts не открывает вторую.
 */
export async function acceptSlackEvent(rt: AgentRuntime, inbound: DeliverSlackEventRequest): Promise<SlackAccept> {
  if (typeof rt.store?.readServices !== "function" || typeof rt.store.dir !== "function" || typeof rt.store.chats?.create !== "function") {
    return "unavailable";
  }
  const services = await rt.store.readServices();
  const recipe = services?.recipes.find(
    (item) => messengerAdapter(item) === "slack" && services.credentials.some((cred) => cred.slug === item.slug),
  );
  const cred = recipe ? services?.credentials.find((item) => item.slug === recipe.slug) : undefined;
  const token = tokenOf(cred);
  if (!recipe || !cred || !token) return "unavailable";
  const identity = await cachedIdentity(rt, recipe.slug, token);
  if (!identity) return "unavailable";
  await rememberSlackUser(rt, cred, identity.userId);
  const event = inbound.event;
  const im = event.channelType === "im" || event.channel.startsWith("D");
  const heard = hearSlack({
    teamId: identity.teamId,
    selfId: identity.userId,
    channelId: event.channel,
    im,
    followedThreads: im ? undefined : await followedThreads(rt, event.channel),
    messages: [
      {
        type: "message",
        ...(event.user ? { user: event.user } : {}),
        ...(event.botId ? { bot_id: event.botId } : {}),
        ...(event.subtype ? { subtype: event.subtype } : {}),
        ...(event.text ? { text: event.text } : {}),
        ts: event.ts,
        ...(event.threadTs ? { thread_ts: event.threadTs } : {}),
      },
    ],
  });
  const item = heard[0];
  if (!item) return "ignored";
  if (!(await claimSeen(rt, item.externalId))) return "duplicate";
  try {
    const state = await readState(rt);
    const name = await authorName(token, state, item.authorId, globalThis.fetch);
    const context = await threadContext(token, state, identity.userId, item, globalThis.fetch);
    await writeState(rt, state);
    await ingest(rt, recipe.slug, name, item, context);
    return "accepted";
  } catch (e) {
    await forgetSeen(rt, item.externalId);
    warn("channel", "событие Slack не принято", { id: inbound.eventId, error: String(e) });
    throw e;
  }
}

/** Ответ агента в диалоге мессенджера уходит в тот же тред. */
export async function deliverChannelReply(rt: AgentRuntime, link: ChannelLink, message: ChatMessage): Promise<void> {
  const text = textForMessenger(message);
  if (!text || link.adapter !== "slack") return;
  const services = await rt.store.readServices();
  const cred = services?.credentials.find((item) => item.slug === link.slug);
  const token = tokenOf(cred);
  if (!token) {
    warn("channel", "нет токена, чтобы ответить в Slack", { slug: link.slug });
    return;
  }
  try {
    const ts = await slackPost(
      token,
      { channel: link.channel, text: redactInternal(text), threadTs: link.threadTs },
      globalThis.fetch,
    );
    await exclusive(async () => {
      const state = await readState(rt);
      if (ts) {
        const id = `${link.channel}:${ts}`;
        if (!state.seen.includes(id)) state.seen.push(id);
        const cursorKey = `${link.slug}:${link.channel}`;
        if (!state.cursors[cursorKey] || ts > state.cursors[cursorKey]) state.cursors[cursorKey] = ts;
      }
      const file = stateFile(rt);
      if (file) {
        state.seen = state.seen.slice(-MAX_SEEN);
        await writeJson(file, state);
      }
    });
    if (message.runId) await rt.step(message.runId, "note", "ответ отправлен в Slack");
  } catch (e) {
    warn("channel", "ответ в Slack не ушёл", { error: String(e) });
    if (message.runId) await rt.step(message.runId, "note", `ответ в Slack не ушёл: ${String(e)}`);
  }
}
