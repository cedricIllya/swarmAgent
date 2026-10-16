import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeSlackChoice, slackFileRefs, type SlackFileRef } from "@swarm/contracts";

/**
 * Slack Web API. Токен — bot или user из доступа сервиса (`xoxb-`, `xoxp-` и любой,
 * который принимает `auth.test`). Личные сообщения читаются целиком, в каналах —
 * только упоминания. Сообщение с файлом тоже: текст вкладывается в задачу,
 * картинка и прочий файл сохраняются на диск. Ответ уходит в тот же диалог.
 * Кнопки вариантов пишет бот.
 */

export interface SlackRawMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  files?: unknown;
}

export interface HeardSlack {
  externalId: string;
  threadKey: string;
  authorId: string;
  text: string;
  channel: string;
  /** В канале ответ идёт в тред. В личке поле пустое: весь диалог — один чат. */
  threadTs?: string;
  /** ts сообщения, под которым публиковать ответ. В треде это корень, не реплика. */
  replyTs: string;
  im: boolean;
  files: SlackFileRef[];
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

const MAX_DOWNLOAD = 8 * 1024 * 1024;
const MAX_INLINE = 12_000;
const MAX_MESSAGE = 20_000;
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "html", "htm", "css",
  "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "sql", "sh", "toml", "ini", "svg", "env",
]);
const TEXT_MIME = new Set([
  "application/json", "application/xml", "application/javascript", "application/x-yaml",
  "application/yaml", "application/csv", "application/sql", "image/svg+xml",
]);

function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

/** Подпись файла в тексте задачи. */
export function slackFileLabel(file: SlackFileRef, extra = ""): string {
  const bits = [file.mimetype || "файл"];
  if (file.size > 0) bits.push(formatBytes(file.size));
  if (extra) bits.push(extra);
  return `[файл ${file.name}, ${bits.join(", ")}]`;
}

function withPreview(head: string, preview?: string): string {
  const body = preview?.trim();
  if (!body) return head;
  return `${head}\n${body.slice(0, 1500)}`;
}

/** Строка треда: реплика и имена файлов, без скачивания. Служебный subtype — пусто. */
export function slackThreadLine(message: SlackRawMessage): string {
  if (message.subtype && message.subtype !== "file_share") return "";
  const text = slackPlainText(message.text ?? "");
  const notes = slackFileRefs(message.files).map((file) => withPreview(slackFileLabel(file), file.preview));
  return [text, ...notes].filter(Boolean).join("\n").slice(0, 1500);
}

function inlineText(file: SlackFileRef): boolean {
  const mime = file.mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return false;
  if (mime === "application/pdf" || mime.startsWith("application/zip") || mime.startsWith("application/vnd.")) return false;
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return false;
  if (mime.startsWith("text/") || TEXT_MIME.has(mime) || mime === "image/svg+xml") return true;
  const ext = fileExtension(file.name);
  if (TEXT_EXT.has(ext)) return true;
  return mime === "" || mime === "application/octet-stream";
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

/** Скачивать можно только адрес, который отдал сам Slack. */
function slackDownloadUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Файл Slack отдаёт 302 на подписанный адрес. Токен нужен только первому запросу:
 * на чужой хост его не пересылаем.
 */
async function downloadSlackFile(
  token: string,
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const first = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get("location");
    if (!location) return null;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return null;
    }
    if (next.protocol !== "https:") return null;
    res = await fetchImpl(next.toString(), { redirect: "manual" });
  }
  if (!res.ok) return null;
  const bytes = await readLimited(res);
  if (!bytes) return null;
  return { bytes, contentType: res.headers.get("content-type") ?? "" };
}

/** Читает тело, пока оно не больше предела. Дальше соединение закрывается. */
async function readLimited(res: Response): Promise<Uint8Array | null> {
  const length = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_DOWNLOAD) return null;
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOWNLOAD) return null;
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD) {
        overflow = true;
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    if (!overflow) reader.releaseLock();
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function diskName(file: SlackFileRef): string {
  const id = file.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "file";
  const base = (file.name.split(/[/\\]/).pop() ?? "file").replace(/[^\w.\- \u0400-\u04FF]+/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
  return `${id}-${base || "file"}`;
}

async function saveBytes(dir: string, file: SlackFileRef, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o755).catch(() => undefined);
  const dest = path.join(dir, diskName(file));
  await writeFile(dest, bytes, { mode: 0o644 });
  return dest;
}

function refineFile(file: SlackFileRef, info: Record<string, unknown> | undefined): { file: SlackFileRef; url: string | null } {
  if (!info) return { file, url: null };
  const [refined] = slackFileRefs([{ ...info, id: file.id }]);
  const next: SlackFileRef = refined
    ? {
        id: file.id,
        name: refined.name !== "файл" ? refined.name : file.name,
        mimetype: refined.mimetype || file.mimetype,
        size: refined.size || file.size,
        ...((refined.preview ?? file.preview) ? { preview: refined.preview ?? file.preview ?? "" } : {}),
      }
    : file;
  if (!next.preview) delete next.preview;
  return { file: next, url: slackDownloadUrl(info.url_private_download) ?? slackDownloadUrl(info.url_private) };
}

async function readOne(token: string, file: SlackFileRef, saveDir: string | null, fetchImpl: typeof fetch): Promise<string> {
  let current = file;
  let url: string | null = null;
  try {
    const data = await slackCall<{ file?: Record<string, unknown> } & SlackOk>(token, "files.info", { file: file.id }, fetchImpl);
    const refined = refineFile(file, data.file);
    current = refined.file;
    url = refined.url;
  } catch (e) {
    const reason = String(e).includes("missing_scope") ? "нет права files:read" : "содержимое не прочитано";
    return withPreview(slackFileLabel(current, reason), current.preview);
  }
  if (!url) return withPreview(slackFileLabel(current, "содержимое не прочитано"), current.preview);
  if (current.size > MAX_DOWNLOAD) return withPreview(slackFileLabel(current, "слишком большой, чтобы скачать"), current.preview);
  let downloaded: { bytes: Uint8Array; contentType: string } | null = null;
  try {
    downloaded = await downloadSlackFile(token, url, fetchImpl);
  } catch {
    downloaded = null;
  }
  if (!downloaded) return withPreview(slackFileLabel(current, "содержимое не прочитано"), current.preview);
  const headerType = downloaded.contentType.split(";")[0]?.trim() ?? "";
  if (headerType && !current.mimetype) current = { ...current, mimetype: headerType.slice(0, 128) };
  const decoded = decodeUtf8(downloaded.bytes);
  if (decoded !== null && inlineText(current)) {
    const body = decoded.trim().slice(0, MAX_INLINE);
    const clipped = decoded.trim().length > MAX_INLINE ? "\n…файл обрезан" : "";
    return `${slackFileLabel(current)}\n${body}${clipped}`;
  }
  if (!saveDir) return withPreview(slackFileLabel(current, "содержимое не прочитано"), current.preview);
  try {
    const saved = await saveBytes(saveDir, current, downloaded.bytes);
    return withPreview(slackFileLabel(current, `лежит в ${saved} — открой и посмотри`), current.preview);
  } catch {
    return withPreview(slackFileLabel(current, "не сохранился на диск"), current.preview);
  }
}

/**
 * Текст сообщения плюс содержимое файлов.
 * Текстовый файл вкладывается в задачу. Картинку и прочее кладёт в `saveDir`,
 * чтобы агент открыл их сам. Пустой список файлов текст не меняет.
 */
export async function slackReadFiles(
  token: string,
  text: string,
  files: SlackFileRef[],
  saveDir: string | null,
  fetchImpl: typeof fetch,
): Promise<string> {
  const list = files.slice(0, 8);
  if (list.length === 0) return text;
  const parts: string[] = [];
  if (text.trim()) parts.push(text.trim());
  for (const file of list) parts.push(await readOne(token, file, saveDir, fetchImpl));
  return parts.join("\n\n").slice(0, MAX_MESSAGE);
}

/**
 * Какие сообщения этого канала адресованы агенту. Свои и служебные пропускает.
 * `file_share` — сообщение с файлом, его оставляет. В канале — упоминание
 * user-токена или бота, событие `app_mention`, либо реплика в треде, куда агента
 * уже звали. `followedThreads` — ts корня таких тредов.
 * Упоминание бота не совпадает с id `auth.test` пользовательского токена.
 */
export function hearSlack(args: {
  teamId: string;
  selfId: string;
  /** Id бота приложения. В тексте упоминания стоит он, а не `selfId`. */
  botUserIds?: readonly string[];
  channelId: string;
  im: boolean;
  messages: SlackRawMessage[];
  followedThreads?: ReadonlySet<string>;
}): HeardSlack[] {
  const own = new Set([args.selfId, ...(args.botUserIds ?? [])].filter(Boolean));
  const out: HeardSlack[] = [];
  for (const message of args.messages) {
    if (message.type && message.type !== "message" && message.type !== "app_mention") continue;
    if (message.bot_id) continue;
    if (message.subtype && message.subtype !== "file_share") continue;
    if (!message.user || !message.ts || own.has(message.user)) continue;
    const files = slackFileRefs(message.files);
    const text = slackPlainText(message.text ?? "");
    if (!text && files.length === 0) continue;
    const raw = message.text ?? "";
    const mentioned = [...own].some((id) => raw.includes(`<@${id}>`));
    const followed = Boolean(message.thread_ts && args.followedThreads?.has(message.thread_ts));
    if (!args.im && !mentioned && !followed && message.type !== "app_mention") continue;
    const replyTs = message.thread_ts || message.ts;
    const threadTs = args.im ? undefined : replyTs;
    out.push({
      externalId: `${args.channelId}:${message.ts}`,
      threadKey: args.im ? `slack:${args.teamId}:${args.channelId}` : `slack:${args.teamId}:${args.channelId}:${threadTs}`,
      authorId: message.user,
      text: text.slice(0, 4000),
      channel: args.channelId,
      ...(threadTs ? { threadTs } : {}),
      replyTs,
      im: args.im,
      files,
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

/** Реплики треда, родитель первым. История канала их не содержит. */
export async function slackReplies(
  token: string,
  channel: string,
  threadTs: string,
  fetchImpl: typeof fetch,
): Promise<SlackRawMessage[]> {
  const data = await slackCall<{ messages?: SlackRawMessage[] } & SlackOk>(
    token,
    "conversations.replies",
    { channel, ts: threadTs, limit: 30 },
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

function slackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Подпись кнопки — не длиннее 75 символов, иначе Slack отклоняет блок. */
function buttonLabel(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  if (chars.length <= 75) return chars.join("");
  return `${chars.slice(0, 74).join("")}…`;
}

/**
 * Вопрос с кнопками. Токен — бота приложения: на сообщении пользователя кнопки не живут.
 * В одном ряду не больше пяти кнопок.
 */
export async function slackPostChoices(
  token: string,
  args: {
    channel: string;
    threadTs: string;
    text: string;
    agentId: string;
    approvalId: string;
    options: string[];
  },
  fetchImpl: typeof fetch,
): Promise<string> {
  const prompt = slackMrkdwn(args.text.trim().slice(0, 2900));
  const elements = args.options.slice(0, 6).map((option, index) => ({
    type: "button",
    action_id: `swarm_choice_${index}`,
    text: { type: "plain_text", text: buttonLabel(option), emoji: true },
    value: encodeSlackChoice({ agentId: args.agentId, approvalId: args.approvalId, index }),
  }));
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: prompt } }];
  for (let i = 0; i < elements.length; i += 5) {
    blocks.push({
      type: "actions",
      block_id: i === 0 ? "swarm_choices" : `swarm_choices_${i}`,
      elements: elements.slice(i, i + 5),
    });
  }
  const data = await slackCall<{ ts?: string } & SlackOk>(
    token,
    "chat.postMessage",
    {
      channel: args.channel,
      text: prompt,
      thread_ts: args.threadTs,
      blocks: JSON.stringify(blocks),
    },
    fetchImpl,
  );
  return data.ts ?? "";
}
