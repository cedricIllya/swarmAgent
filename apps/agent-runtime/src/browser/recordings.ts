import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Ролик Skyvern по прямой ссылке из результата задачи. */
export async function downloadUrlTo(url: string, targetPath: string): Promise<boolean> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) return false;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(targetPath));
  return true;
}
