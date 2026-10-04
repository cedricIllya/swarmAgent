import type { BrowserSession } from "@swarm/contracts";
import type { Store } from "../store";
import { downloadUrlTo } from "./recordings";
import { log, warn } from "../log";

/**
 * Skyvern только для регистрации и входа. Задачи внутри сервиса — Stagehand.
 * Запускаем task через REST, ждём, скачиваем ролик в ту же папку сессий.
 * https://docs.skyvern.com/api-reference
 */
export class SkyvernClient {
  constructor(
    private readonly apiKey: string,
    private readonly store: Store,
    private readonly base = "https://api.skyvern.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async runLoginOrSignup(args: {
    runId: string;
    url: string;
    prompt: string;
    purpose: "signup" | "login";
    /** Что передать на форму: email агента, пароль из хранилища. Не логируется. */
    credentials: Record<string, string>;
    timeoutMs?: number;
    /** Сессия создана и сохранена — можно показать её владельцу. */
    onSession?: (session: BrowserSession) => Promise<void>;
  }): Promise<{ session: BrowserSession; status: string; output: unknown }> {
    const res = await this.fetchImpl(`${this.base}/v1/run/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({
        prompt: args.prompt,
        url: args.url,
        engine: "skyvern-2.0",
        data_extraction_schema: {
          type: "object",
          properties: {
            logged_in: { type: "boolean" },
            account_email: { type: "string" },
            notes: { type: "string" },
          },
        },
        totp_identifier: null,
        parameters: args.credentials,
      }),
    });
    if (!res.ok) throw new Error(`Skyvern ${res.status}: ${await res.text()}`);
    const created = (await res.json()) as { run_id: string };
    const runId = created.run_id;

    const meta: BrowserSession = {
      id: `skyvern-${runId}`,
      runId: args.runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      provider: "skyvern",
      purpose: `${args.purpose}: ${args.url}`,
      hasVideo: false,
      liveUrl: null,
    };
    await this.store.saveBrowserSession(meta);
    await this.store.appendBrowserAction(meta.id, { type: "skyvern.start", purpose: args.purpose, url: args.url });
    await args.onSession?.(meta);

    const deadline = Date.now() + (args.timeoutMs ?? 15 * 60 * 1000);
    let status = "running";
    let output: unknown = null;
    let recordingUrl: string | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const r = await this.fetchImpl(`${this.base}/v1/runs/${runId}`, {
        headers: { "x-api-key": this.apiKey },
      });
      if (!r.ok) continue;
      const json = (await r.json()) as {
        status: string;
        output?: unknown;
        recording_url?: string | null;
        failure_reason?: string | null;
      };
      status = json.status;
      if (["completed", "failed", "terminated", "canceled", "timed_out"].includes(status)) {
        output = json.output ?? null;
        recordingUrl = json.recording_url ?? null;
        await this.store.appendBrowserAction(meta.id, {
          type: "skyvern.finish",
          status,
          failureReason: json.failure_reason ?? null,
        });
        break;
      }
    }

    if (recordingUrl) {
      try {
        meta.hasVideo = await downloadUrlTo(recordingUrl, this.store.videoPath(meta.id));
      } catch (e) {
        warn("skyvern", "не удалось скачать ролик", { error: String(e) });
      }
    }
    meta.finishedAt = new Date().toISOString();
    await this.store.saveBrowserSession(meta);
    log("skyvern", "задача завершена", { runId, status, hasVideo: meta.hasVideo });
    return { session: meta, status, output };
  }
}
