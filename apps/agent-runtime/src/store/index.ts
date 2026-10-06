import { mkdir, readFile, readdir, appendFile, writeFile, stat, unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { withoutForeignEndpoints, type BrowserSession, type InboundEmail, type PendingApproval, type Run, type RunStep, type ServicesSnapshot, type UsageRecord } from "@swarm/contracts";
import { parseUsageJsonl, summarizeUsage } from "@swarm/usage";
import { shotFile } from "../browser/shots";
import { emitRuntime } from "../core/events";
import { ChatStore } from "./chats";
import { SHARED_MODE, chmodShared, readJson, readJsonl, writeJson } from "./files";

export type { ChatMeta } from "./chats";

/**
 * Всё состояние runtime лежит файлами на volume агента. Без базы:
 * машина одна, процесс один, перезапуск читает файлы обратно.
 */
export class Store {
  readonly chats: ChatStore;

  constructor(readonly root: string) {
    this.chats = new ChatStore(root, this);
  }

  dir(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  async init(): Promise<void> {
    for (const d of ["runs", "browser-sessions", "browser-profiles", "deferred-emails", "skills", "cron", "chats"]) {
      await mkdir(this.dir(d), { recursive: true });
    }
    await this.chats.migrateLegacy();
    await chmod(this.dir("skills"), 0o755).catch(() => undefined);
    await chmodShared(this.dir("services.json"));
  }

  // Runs

  async saveRun(run: Run): Promise<void> {
    await writeJson(this.dir("runs", run.id, "run.json"), run);
    emitRuntime({ type: "run", run });
    await this.chats.emit();
  }

  async getRun(id: string): Promise<Run | null> {
    return readJson<Run | null>(this.dir("runs", id, "run.json"), null);
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
    return readJsonl<RunStep>(this.dir("runs", runId, "steps.jsonl"));
  }

  // Sent emails: Message-ID → run/thread

  async rememberSent(messageId: string, meta: { runId: string; to: string; approvalId: string | null }): Promise<void> {
    const sent = await readJson<Record<string, typeof meta>>(this.dir("sent.json"), {});
    sent[messageId] = meta;
    await writeJson(this.dir("sent.json"), sent);
  }

  async sentMessages(): Promise<Record<string, { runId: string; to: string; approvalId: string | null }>> {
    return readJson(this.dir("sent.json"), {});
  }

  // Approvals

  async listApprovals(): Promise<PendingApproval[]> {
    const list = await readJson<Array<PendingApproval & { chatId?: string | null }>>(this.dir("approvals.json"), []);
    return list.map((p) => ({ ...p, chatId: p.chatId ?? null }));
  }

  async saveApprovals(list: PendingApproval[]): Promise<void> {
    await writeJson(this.dir("approvals.json"), list);
    emitRuntime({ type: "approvals", approvals: list });
  }

  /** Контекст передачи человеку, включая пароль. В чат и в state не попадает. */
  async readHandoffContexts<T>(): Promise<Record<string, T>> {
    return readJson(this.dir("handoffs.json"), {});
  }

  async writeHandoffContexts(all: Record<string, unknown>): Promise<void> {
    await writeJson(this.dir("handoffs.json"), all, 0o600);
  }

  // Browser sessions

  async saveBrowserSession(s: BrowserSession): Promise<void> {
    await writeJson(this.dir("browser-sessions", s.id, "session.json"), s);
    emitRuntime({ type: "browserSession", session: s });
  }

  async listBrowserSessions(): Promise<BrowserSession[]> {
    const ids = await readdir(this.dir("browser-sessions")).catch(() => []);
    const out: BrowserSession[] = [];
    for (const id of ids) {
      const s = await readJson<(BrowserSession & { liveUrl?: string | null }) | null>(
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
    return readJsonl(this.dir("browser-sessions", sessionId, "actions.jsonl"));
  }

  videoPath(sessionId: string): string {
    return this.dir("browser-sessions", sessionId, "video.mp4");
  }

  /** Кадр своего браузера. Чужое имя файла сюда не проходит. */
  shotPath(sessionId: string, file: string): string | null {
    const name = shotFile(file);
    if (!name || !/^[\w.-]+$/.test(sessionId)) return null;
    return this.dir("browser-sessions", sessionId, "shots", name);
  }

  async hasVideo(sessionId: string): Promise<boolean> {
    return stat(this.videoPath(sessionId))
      .then((s) => s.size > 0)
      .catch(() => false);
  }

  // Deferred emails: пришли, пока агент был в браузере

  async deferEmail(email: InboundEmail & { classifyAttempts?: number }): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeJson(this.dir("deferred-emails", `${id}.json`), email);
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
      const e = await readJson<InboundEmail | null>(full, null);
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
    await writeJson(this.dir("services.json"), snapshot, SHARED_MODE);
  }

  async readServices(): Promise<ServicesSnapshot | null> {
    const snap = await readJson<ServicesSnapshot | null>(this.dir("services.json"), null);
    if (!snap) return null;
    return { ...snap, recipes: snap.recipes.map((recipe) => withoutForeignEndpoints(recipe)) };
  }

  async writeGoogleToken(token: Record<string, unknown>): Promise<void> {
    await writeFile(this.dir("google_token.json"), JSON.stringify(token), { mode: 0o644 });
  }

  async deleteGoogleToken(): Promise<void> {
    await unlink(this.dir("google_token.json")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  hasGoogleToken(): boolean {
    return existsSync(this.dir("google_token.json"));
  }

  async readSettings(): Promise<{ autonomous?: boolean; model?: string }> {
    return readJson(this.dir("settings.json"), {});
  }

  async writeSettings(patch: { autonomous?: boolean; model?: string }): Promise<void> {
    const cur = await this.readSettings();
    await writeJson(this.dir("settings.json"), { ...cur, ...patch });
  }
}
