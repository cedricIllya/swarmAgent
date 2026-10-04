import { mkdir, readFile, readdir, appendFile, writeFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  BrowserSession,
  ChatMessage,
  InboundEmail,
  PendingApproval,
  Run,
  RunStep,
  ServicesSnapshot,
  UsageRecord,
} from "@swarm/contracts";
import { parseUsageJsonl, summarizeUsage } from "@swarm/usage";

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
    for (const d of ["runs", "browser-sessions", "browser-profiles", "deferred-emails", "skills", "cron"]) {
      await mkdir(this.dir(d), { recursive: true });
    }
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value, null, 2));
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

  // Runs

  async saveRun(run: Run): Promise<void> {
    await this.writeJson(this.dir("runs", run.id, "run.json"), run);
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
  }

  async listSteps(runId: string): Promise<RunStep[]> {
    return this.readJsonl<RunStep>(this.dir("runs", runId, "steps.jsonl"));
  }

  // Chat

  async addChat(msg: ChatMessage): Promise<void> {
    await appendFile(this.dir("chat.jsonl"), JSON.stringify(msg) + "\n");
  }

  async listChat(limit = 200): Promise<ChatMessage[]> {
    const all = await this.readJsonl<ChatMessage>(this.dir("chat.jsonl"));
    return all.slice(-limit);
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
    return this.readJson<PendingApproval[]>(this.dir("approvals.json"), []);
  }

  async saveApprovals(list: PendingApproval[]): Promise<void> {
    await this.writeJson(this.dir("approvals.json"), list);
  }

  // Browser sessions

  async saveBrowserSession(s: BrowserSession): Promise<void> {
    await this.writeJson(this.dir("browser-sessions", s.id, "session.json"), s);
  }

  async listBrowserSessions(): Promise<BrowserSession[]> {
    const ids = await readdir(this.dir("browser-sessions")).catch(() => []);
    const out: BrowserSession[] = [];
    for (const id of ids) {
      const s = await this.readJson<BrowserSession | null>(this.dir("browser-sessions", id, "session.json"), null);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async appendBrowserAction(sessionId: string, action: Record<string, unknown>): Promise<void> {
    await mkdir(this.dir("browser-sessions", sessionId), { recursive: true });
    await appendFile(
      this.dir("browser-sessions", sessionId, "actions.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...action }) + "\n",
    );
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
    await this.writeJson(this.dir("services.json"), snapshot);
  }

  async readServices(): Promise<ServicesSnapshot | null> {
    return this.readJson<ServicesSnapshot | null>(this.dir("services.json"), null);
  }

  async writeGoogleToken(token: Record<string, unknown>): Promise<void> {
    await writeFile(this.dir("google_token.json"), JSON.stringify(token), { mode: 0o600 });
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
