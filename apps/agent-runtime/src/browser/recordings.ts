import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type Browserbase from "@browserbasehq/sdk";
import { log, warn } from "../log";

/**
 * Browserbase пишет ролик сам. После сессии просим собрать MP4 и кладём
 * его в `browser-sessions/<id>/video.mp4` рядом с `actions.jsonl`.
 */
export async function downloadRecording(
  bb: Browserbase,
  browserbaseSessionId: string,
  targetPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60 * 1000);
  try {
    await bb.sessions.recording.downloads.create(browserbaseSessionId);
  } catch (e) {
    warn("recordings", "не удалось запросить сборку MP4", { error: String(e) });
    return false;
  }

  let downloads: Array<{ pageId?: string; status: string; downloadUrl?: string | null }> = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const res = (await bb.sessions.recording.downloads.list(browserbaseSessionId)) as {
      downloads?: typeof downloads;
    };
    downloads = res.downloads ?? [];
    if (downloads.length && !downloads.some((d) => d.status === "PENDING")) break;
  }

  const ready = downloads.find((d) => d.status === "COMPLETED" && d.downloadUrl);
  if (!ready?.downloadUrl) {
    warn("recordings", "MP4 не готов", { browserbaseSessionId, downloads });
    return false;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetch(ready.downloadUrl);
  if (!res.ok || !res.body) {
    warn("recordings", "не удалось скачать MP4", { status: res.status });
    return false;
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(targetPath));
  log("recordings", "видео сохранено", { targetPath });
  return true;
}

/** Ролик Skyvern по прямой ссылке из результата задачи. */
export async function downloadUrlTo(url: string, targetPath: string): Promise<boolean> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) return false;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(targetPath));
  return true;
}
