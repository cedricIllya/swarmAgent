import { mkdir, readFile, readdir, appendFile, writeFile, stat, unlink, chmod, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  BrowserSession,
  ChatMessage,
  ChatThread,
  InboundEmail,
  PendingApproval,
  Run,
  RunStep,
  ServicesSnapshot,
  UsageRecord,
} from "@swarm/contracts";
import { parseUsageJsonl, summarizeUsage } from "@swarm/usage";
import { emitRuntime } from "./events";

/** Volume общий с Hermes: файл должен быть читаем не только владельцем. */
const SHARED_MODE = 0o644;

interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  /** Служебный чат почты и крона. Не уезжает в API. */
  kind?: "mail";
}

function newChatId(): string {
  return `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

/**
 * Всё состояние runtime лежит файлами на volume агента. Без базы:
 * машина одна, процесс один, перезапуск читает файлы обратно.
 */
export class Store {
  constructor(readonly root: string) {}

  dir(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  async init(): Promise<void> {
    for (const d of ["runs", "browser-sessions", "browser-profiles", "deferred-emails", "skills", "cron", "chats"]) {
      await mkdir(this.dir(d), { recursive: true });
    }
    await this.migrateLegacyChat();
    await chmod(this.dir("skills"), 0o755).catch(() => undefined);
    await this.chmodShared(this.dir("services.json"));
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(file: string, value: unknown, mode?: number): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2));
    if (mode) await chmod(file, mode);
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      const text = await readFile(file, "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
  }

  private async chmodShared(file: string): Promise<void> {
    if (!existsSync(file)) return;
    await chmod(file, SHARED_MODE).catch(() => undefined);
  }

  // Runs

  async saveRun(run: Run): Promise<void> {
    await this.writeJson(this.dir("runs", run.id, "run.json"), run);
    emitRuntime({ type: "run", run });
    await this.emitChats();
  }

  async getRun(id: string): Promise<Run | null> {
    return this.readJson<Run | null>(this.dir("runs", id, "run.json"), null);
  }

  async listRuns(limit = 100): Promise<Run[]> {
    const ids = await readdir(this.dir("runs")).catch(() => []);
    const runs: Run[] = [];
    for (const id of ids) {
      const r = await this.getRun(id);
      if (r) runs.push(r);
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async addStep(runId: string, step: RunStep): Promise<void> {
    await mkdir(this.dir("runs", runId), { recursive: true });
    await appendFile(this.dir("runs", runId, "steps.jsonl"), JSON.stringify(step) + "\n");
    emitRuntime({ type: "step", runId, step });
  }

  async listSteps(runId: string): Promise<RunStep[]> {
    return this.readJsonl<RunStep>(this.dir("runs", runId, "steps.jsonl"));
  }

  // Chats

  private chatDir(id: string): string {
    return this.dir("chats", id);
  }

  private async readChatMeta(id: string): Promise<ChatMeta | null> {
    const meta = await this.readJson<ChatMeta | null>(path.join(this.chatDir(id), "chat.json"), null);
    if (!meta?.id) return null;
    return meta;
  }

  private async writeChatMeta(meta: ChatMeta): Promise<void> {
    await this.writeJson(path.join(this.chatDir(meta.id), "chat.json"), meta);
  }

  private async listChatMetas(): Promise<ChatMeta[]> {
    const ids = await readdir(this.dir("chats")).catch(() => [] as string[]);
    const out: ChatMeta[] = [];
    for (const id of ids) {
      const meta = await this.readChatMeta(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  async createChat(title: string, kind?: "mail"): Promise<ChatMeta> {
    const now = new Date().toISOString();
    const meta: ChatMeta = {
      id: newChatId(),
      title: title.slice(0, 80) || "Новый чат",
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      ...(kind ? { kind } : {}),
    };
    await mkdir(this.chatDir(meta.id), { recursive: true });
    await this.writeChatMeta(meta);
    await this.emitChats();
    return meta;
  }

  async getChat(id: string): Promise<ChatMeta | null> {
    return this.readChatMeta(id);
  }

  async renameChat(id: string, title: string): Promise<ChatMeta | null> {
    const meta = await this.readChatMeta(id);
    if (!meta) return null;
    meta.title = title.slice(0, 80) || meta.title;
    meta.updatedAt = new Date().toISOString();
    await this.writeChatMeta(meta);
    await this.emitChats();
    return meta;
  }

  async deleteChat(id: string): Promise<boolean> {
    const meta = await this.readChatMeta(id);
    if (!meta) return false;
    await rm(this.chatDir(id), { recursive: true, force: true });
    await this.emitChats();
    return true;
  }

  /** Чат писем и плановых проверок. Создаётся при первом таком сообщении. */
  async ensureSystemChat(): Promise<ChatMeta> {
    const found = (await this.listChatMetas()).find((c) => c.kind === "mail");
    if (found) return found;
    return this.createChat("Почта и расписание", "mail");
  }

  async addChatMessage(chatId: string, msg: ChatMessage): Promise<void> {
    const meta = await this.readChatMeta(chatId);
    if (!meta) throw new Error("chat не найден");
    await appendFile(path.join(this.chatDir(chatId), "messages.jsonl"), JSON.stringify(msg) + "\n");
    meta.lastMessage = preview(msg.text);
    meta.updatedAt = msg.at;
    await this.writeChatMeta(meta);
    emitRuntime({ type: "chatMessage", chatId, message: msg });
    await this.emitChats();
  }

  async listChatMessages(chatId: string, limit = 200): Promise<ChatMessage[]> {
    const all = await this.readJsonl<ChatMessage>(path.join(this.chatDir(chatId), "messages.jsonl"));
    return all.slice(-limit);
  }

  async listChats(): Promise<ChatThread[]> {
    const [metas, runs] = await Promise.all([this.listChatMetas(), this.listRuns(200)]);
    const busy = new Set(
      runs.filter((r) => (r.status === "running" || r.status === "queued") && r.threadId).map((r) => r.threadId),
    );
    return metas
      .map((m) => ({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        lastMessage: m.lastMessage,
        busy: busy.has(m.id),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async emitChats(): Promise<void> {
    emitRuntime({ type: "chats", chats: await this.listChats() });
  }

  /** Старый общий chat.jsonl становится чатом «Общий». */
  private async migrateLegacyChat(): Promise<void> {
    const legacy = this.dir("chat.jsonl");
    if (!existsSync(legacy)) return;
    const messages = await this.readJsonl<Omit<ChatMessage, "chatId"> & { chatId?: string }>(legacy);
    const chat = await this.createChat("Общий");
    if (messages.length) {
      const lines = messages.map((m) => JSON.stringify({ ...m, chatId: chat.id }) + "\n").join("");
      await appendFile(path.join(this.chatDir(chat.id), "messages.jsonl"), lines);
      const last = messages[messages.length - 1]!;
      chat.lastMessage = preview(last.text);
      chat.updatedAt = last.at || chat.updatedAt;
      await this.writeChatMeta(chat);
    }
    await rename(legacy, this.dir("chat.jsonl.migrated"));
    await this.emitChats();
  }

  // Sent emails: Message-ID → run/thread

  async rememberSent(messageId: string, meta: { runId: string; to: string; approvalId: string | null }): Promise<void> {
    const sent = await this.readJson<Record<string, typeof meta>>(this.dir("sent.json"), {});
    sent[messageId] = meta;
    await this.writeJson(this.dir("sent.json"), sent);
  }

  async sentMessages(): Promise<Record<string, { runId: string; to: string; approvalId: string | null }>> {
    return this.readJson(this.dir("sent.json"), {});
  }

  // Approvals

  async listApprovals(): Promise<PendingApproval[]> {
    const list = await this.readJson<Array<PendingApproval & { chatId?: string | null }>>(this.dir("approvals.json"), []);
    return list.map((p) => ({ ...p, chatId: p.chatId ?? null }));
  }

  async saveApprovals(list: PendingApproval[]): Promise<void> {
    await this.writeJson(this.dir("approvals.json"), list);
    emitRuntime({ type: "approvals", approvals: list });
  }

  // Browser sessions

  async saveBrowserSession(s: BrowserSession): Promise<void> {
    await this.writeJson(this.dir("browser-sessions", s.id, "session.json"), s);
    emitRuntime({ type: "browserSession", session: s });
  }

  async listBrowserSessions(): Promise<BrowserSession[]> {
    const ids = await readdir(this.dir("browser-sessions")).catch(() => []);
    const out: BrowserSession[] = [];
    for (const id of ids) {
      const s = await this.readJson<(BrowserSession & { liveUrl?: string | null }) | null>(
        this.dir("browser-sessions", id, "session.json"),
        null,
      );
      if (s) out.push({ ...s, liveUrl: s.liveUrl ?? null });
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async appendBrowserAction(sessionId: string, action: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir("browser-sessions", sessionId), { recursive: true });
    const row = { at: new Date().toISOString(), ...action };
    await appendFile(this.dir("browser-sessions", sessionId, "actions.jsonl"), JSON.stringify(row) + "\n");
    emitRuntime({ type: "browserAction", sessionId, action: row });
  }

  async browserActions(sessionId: string): Promise<Array<Record<string, unknown>>> {
    return this.readJsonl(this.dir("browser-sessions", sessionId, "actions.jsonl"));
  }

  videoPath(sessionId: string): string {
    return this.dir("browser-sessions", sessionId, "video.mp4");
  }

  async hasVideo(sessionId: string): Promise<boolean> {
    return stat(this.videoPath(sessionId))
      .then((s) => s.size > 0)
      .catch(() => false);
  }

  // Deferred emails: пришли, пока агент был в браузере

  async deferEmail(email: InboundEmail): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.writeJson(this.dir("deferred-emails", `${id}.json`), email);
  }

  async hasDeferredEmails(): Promise<boolean> {
    const files = await readdir(this.dir("deferred-emails")).catch(() => [] as string[]);
    return files.some((f) => f.endsWith(".json"));
  }

  async takeDeferredEmails(): Promise<InboundEmail[]> {
    const files = (await readdir(this.dir("deferred-emails")).catch(() => [])).sort();
    const out: InboundEmail[] = [];
    for (const f of files) {
      const full = this.dir("deferred-emails", f);
      const e = await this.readJson<InboundEmail | null>(full, null);
      if (e) out.push(e);
      await unlink(full).catch(() => undefined);
    }
    return out;
  }

  // Usage

  async addUsage(record: UsageRecord): Promise<void> {
    await appendFile(this.dir("usage.jsonl"), JSON.stringify(record) + "\n");
  }

  async usageSummary() {
    const text = await readFile(this.dir("usage.jsonl"), "utf8").catch(() => "");
    return summarizeUsage(parseUsageJsonl(text));
  }

  // Services / settings / google

  async writeServices(snapshot: ServicesSnapshot): Promise<void> {
    await this.writeJson(this.dir("services.json"), snapshot, SHARED_MODE);
  }

  async readServices(): Promise<ServicesSnapshot | null> {
    return this.readJson<ServicesSnapshot | null>(this.dir("services.json"), null);
  }

  async writeGoogleToken(token: Record<string, unknown>): Promise<void> {
    await writeFile(this.dir("google_token.json"), JSON.stringify(token), { mode: 0o644 });
  }

  hasGoogleToken(): boolean {
    return existsSync(this.dir("google_token.json"));
  }

  async readSettings(): Promise<{ autonomous?: boolean; model?: string }> {
    return this.readJson(this.dir("settings.json"), {});
  }

  async writeSettings(patch: { autonomous?: boolean; model?: string }): Promise<void> {
    const cur = await this.readSettings();
    await this.writeJson(this.dir("settings.json"), { ...cur, ...patch });
  }
}
