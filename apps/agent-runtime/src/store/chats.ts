import { appendFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatThread, Run } from "@swarm/contracts";
import { emitRuntime } from "../core/events";
import { readJson, readJsonl, writeJson } from "./files";

export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  /** Служебный чат почты и крона. `channel` — диалог в мессенджере, его видно в журнале. */
  kind?: "mail" | "channel";
  /** Куда отправить ответ агента. В список чатов не попадает. */
  channel?: ChannelLink;
}

/** Диалог мессенджера, привязанный к одному чату карточки. */
export interface ChannelLink {
  adapter: "slack";
  slug: string;
  threadKey: string;
  channel: string;
  threadTs?: string;
}

function newChatId(): string {
  return `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * Чаты на volume: `chats/<id>/chat.json` с метаданными и `messages.jsonl` с историей.
 * Флаг `busy` вычисляется по идущим задачам, поэтому хранилищу нужен доступ к ним.
 */
export class ChatStore {
  constructor(
    private readonly root: string,
    private readonly runs: { listRuns(limit?: number): Promise<Run[]> },
  ) {}

  private dir(id?: string): string {
    return id ? path.join(this.root, "chats", id) : path.join(this.root, "chats");
  }

  private async readMeta(id: string): Promise<ChatMeta | null> {
    const meta = await readJson<ChatMeta | null>(path.join(this.dir(id), "chat.json"), null);
    if (!meta?.id) return null;
    return meta;
  }

  private async writeMeta(meta: ChatMeta): Promise<void> {
    await writeJson(path.join(this.dir(meta.id), "chat.json"), meta);
  }

  private async listMetas(): Promise<ChatMeta[]> {
    const ids = await readdir(this.dir()).catch(() => [] as string[]);
    const out: ChatMeta[] = [];
    for (const id of ids) {
      const meta = await this.readMeta(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  async create(title: string, kind?: "mail" | "channel"): Promise<ChatMeta> {
    const now = new Date().toISOString();
    const meta: ChatMeta = {
      id: newChatId(),
      title: title.slice(0, 80) || "Новый чат",
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      ...(kind ? { kind } : {}),
    };
    await mkdir(this.dir(meta.id), { recursive: true });
    await this.writeMeta(meta);
    await this.emit();
    return meta;
  }

  async get(id: string): Promise<ChatMeta | null> {
    return this.readMeta(id);
  }

  async findByThread(threadKey: string): Promise<string | null> {
    const found = (await this.listMetas()).find((meta) => meta.channel?.threadKey === threadKey);
    return found?.id ?? null;
  }

  async bind(id: string, channel: ChannelLink): Promise<void> {
    const meta = await this.readMeta(id);
    if (!meta) return;
    meta.channel = channel;
    meta.kind = "channel";
    await this.writeMeta(meta);
  }

  async rename(id: string, title: string): Promise<ChatMeta | null> {
    const meta = await this.readMeta(id);
    if (!meta) return null;
    meta.title = title.slice(0, 80) || meta.title;
    meta.updatedAt = new Date().toISOString();
    await this.writeMeta(meta);
    await this.emit();
    return meta;
  }

  async remove(id: string): Promise<boolean> {
    const meta = await this.readMeta(id);
    if (!meta) return false;
    await rm(this.dir(id), { recursive: true, force: true });
    await this.emit();
    return true;
  }

  /** Чат писем и плановых проверок. Создаётся при первом таком сообщении. */
  async ensureSystem(): Promise<ChatMeta> {
    const found = (await this.listMetas()).find((c) => c.kind === "mail");
    if (found) return found;
    return this.create("Почта и расписание", "mail");
  }

  async addMessage(chatId: string, msg: ChatMessage): Promise<void> {
    const meta = await this.readMeta(chatId);
    if (!meta) throw new Error("chat не найден");
    await appendFile(path.join(this.dir(chatId), "messages.jsonl"), JSON.stringify(msg) + "\n");
    meta.lastMessage = preview(msg.text);
    meta.updatedAt = msg.at;
    await this.writeMeta(meta);
    emitRuntime({ type: "chatMessage", chatId, message: msg });
    await this.emit();
  }

  async listMessages(chatId: string, limit = 200): Promise<ChatMessage[]> {
    const all = await readJsonl<ChatMessage>(path.join(this.dir(chatId), "messages.jsonl"));
    return all.slice(-limit);
  }

  async list(): Promise<ChatThread[]> {
    const [metas, runs] = await Promise.all([this.listMetas(), this.runs.listRuns(200)]);
    const mailId = metas.find((m) => m.kind === "mail")?.id ?? null;
    const busy = new Set<string>();
    for (const r of runs) {
      if (r.status !== "running" && r.status !== "queued") continue;
      if (r.trigger === "chat" && r.threadId) busy.add(r.threadId);
      else if (mailId) busy.add(mailId);
    }
    return metas
      .map((m) => ({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        lastMessage: m.lastMessage,
        busy: busy.has(m.id),
        ...(m.kind ? { kind: m.kind } : {}),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Список чатов в шину: вызывается и после смены статуса задачи, чтобы обновить `busy`. */
  async emit(): Promise<void> {
    emitRuntime({ type: "chats", chats: await this.list() });
  }

  /** Старый общий chat.jsonl становится чатом «Общий». */
  async migrateLegacy(): Promise<void> {
    const legacy = path.join(this.root, "chat.jsonl");
    if (!existsSync(legacy)) return;
    const messages = await readJsonl<Omit<ChatMessage, "chatId"> & { chatId?: string }>(legacy);
    const chat = await this.create("Общий");
    if (messages.length) {
      const lines = messages.map((m) => JSON.stringify({ ...m, chatId: chat.id }) + "\n").join("");
      await appendFile(path.join(this.dir(chat.id), "messages.jsonl"), lines);
      const last = messages[messages.length - 1]!;
      chat.lastMessage = preview(last.text);
      chat.updatedAt = last.at || chat.updatedAt;
      await this.writeMeta(chat);
    }
    await rename(legacy, path.join(this.root, "chat.jsonl.migrated"));
    await this.emit();
  }
}
