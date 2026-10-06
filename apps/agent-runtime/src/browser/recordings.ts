import { createWriteStream } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Ролик Skyvern по прямой ссылке. Пишем во временный файл и подменяем цель только целиком. */
export async function downloadUrlTo(url: string, targetPath: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const part = `${targetPath}.part`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) return false;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    await rename(part, targetPath);
    return true;
  } catch (e) {
    await unlink(part).catch(() => undefined);
    throw e;
  }
}

/** WebM у Playwright, MP4 у ролика задачи. Незнакомый файл отдаём как MP4. */
export async function videoMediaType(filePath: string): Promise<string> {
  const fh = await open(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    await fh.read(header, 0, 16, 0);
    if (header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3) return "video/webm";
    if (header.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
    return "video/mp4";
  } finally {
    await fh.close();
  }
}
