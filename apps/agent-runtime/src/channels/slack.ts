/**
 * Slack Web API. Токен — bot или user из доступа сервиса (`xoxb-`, `xoxp-` и любой,
 * который принимает `auth.test`). Личные сообщения читаются целиком, в каналах —
 * только упоминания. Ответ уходит в тот же диалог.
 */

export interface SlackRawMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

export interface HeardSlack {
  externalId: string;
  threadKey: string;
  authorId: string;
  text: string;
  channel: string;
  /** В канале ответ идёт в тред. В личке поле пустое: весь диалог — один чат. */
  threadTs?: string;
  im: boolean;
}

interface SlackOk {
  ok?: boolean;
  error?: string;
}

export function slackPlainText(raw: string): string {
  return raw
    .replace(/<@[A-Z0-9]+>/g, " ")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Какие сообщения этого канала адресованы агенту. Свои и служебные пропускает. */
export function hearSlack(args: {
  teamId: string;
  selfId: string;
  channelId: string;
  im: boolean;
  messages: SlackRawMessage[];
}): HeardSlack[] {
  const out: HeardSlack[] = [];
  for (const message of args.messages) {
    if (message.type && message.type !== "message") continue;
    if (message.subtype || message.bot_id) continue;
    if (!message.user || !message.ts || message.user === args.selfId) continue;
    const text = slackPlainText(message.text ?? "");
    if (!text) continue;
    const mentioned = text.length > 0 && (message.text ?? "").includes(`<@${args.selfId}>`);
    if (!args.im && !mentioned) continue;
    const threadTs = args.im ? undefined : message.thread_ts || message.ts;
    out.push({
      externalId: `${args.channelId}:${message.ts}`,
      threadKey: args.im ? `slack:${args.teamId}:${args.channelId}` : `slack:${args.teamId}:${args.channelId}:${threadTs}`,
      authorId: message.user,
      text: text.slice(0, 4000),
      channel: args.channelId,
      ...(threadTs ? { threadTs } : {}),
      im: args.im,
    });
  }
  return out;
}

function slackForm(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
  }
  return params.toString();
}

/**
 * Тело — form, не JSON. У `conversations.list` Slack молча игнорирует `types` в JSON
 * и отдаёт только публичные каналы, поэтому личные сообщения бот не видит.
 */
async function slackCall<T extends SlackOk>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T> {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: slackForm(body),
  });
  const data = (await res.json()) as T;
  if (!data.ok) throw new Error(data.error || `slack ${method}`);
  return data;
}

export interface SlackIdentity {
  userId: string;
  teamId: string;
}

/** `null` — токен не от Web API (например, только MCP). Слушать тогда нечем. */
export async function slackIdentity(token: string, fetchImpl: typeof fetch): Promise<SlackIdentity | null> {
  try {
    const data = await slackCall<{ user_id?: string; team_id?: string } & SlackOk>(token, "auth.test", {}, fetchImpl);
    if (!data.user_id || !data.team_id) return null;
    return { userId: data.user_id, teamId: data.team_id };
  } catch {
    return null;
  }
}

export interface SlackConversation {
  id: string;
  im: boolean;
}

export async function slackConversations(token: string, fetchImpl: typeof fetch): Promise<SlackConversation[]> {
  const load = async (types: string) => {
    const data = await slackCall<{ channels?: Array<{ id?: string; is_im?: boolean; is_mpim?: boolean; is_member?: boolean; is_archived?: boolean }> } & SlackOk>(
      token,
      "conversations.list",
      { types, limit: 100, exclude_archived: true },
      fetchImpl,
    );
    return data.channels ?? [];
  };
  let channels: Array<{ id?: string; is_im?: boolean; is_mpim?: boolean; is_member?: boolean; is_archived?: boolean }>;
  try {
    channels = await load("im,mpim,public_channel,private_channel");
  } catch {
    channels = await load("im");
  }
  return channels
    .filter((channel) => channel.id && !channel.is_archived && (channel.is_im || channel.is_member !== false))
    .slice(0, 40)
    .map((channel) => ({ id: channel.id as string, im: channel.is_im === true }));
}

export async function slackHistory(
  token: string,
  channel: string,
  oldest: string,
  fetchImpl: typeof fetch,
): Promise<SlackRawMessage[]> {
  const data = await slackCall<{ messages?: SlackRawMessage[] } & SlackOk>(
    token,
    "conversations.history",
    { channel, oldest, limit: 30, inclusive: false },
    fetchImpl,
  );
  return data.messages ?? [];
}

export async function slackDisplayName(token: string, userId: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const data = await slackCall<{ user?: { real_name?: string; profile?: { display_name?: string } } } & SlackOk>(
      token,
      "users.info",
      { user: userId },
      fetchImpl,
    );
    const name = data.user?.profile?.display_name?.trim() || data.user?.real_name?.trim();
    return name || userId;
  } catch {
    return userId;
  }
}

export async function slackPost(
  token: string,
  args: { channel: string; text: string; threadTs?: string | undefined },
  fetchImpl: typeof fetch,
): Promise<string> {
  const data = await slackCall<{ ts?: string } & SlackOk>(
    token,
    "chat.postMessage",
    {
      channel: args.channel,
      text: args.text.slice(0, 4000),
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    },
    fetchImpl,
  );
  return data.ts ?? "";
}
