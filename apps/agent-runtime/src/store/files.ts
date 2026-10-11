import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** Volume общий с Hermes: файл должен быть читаем не только владельцем. */
export const SHARED_MODE = 0o644;

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

let tmpSeq = 0;

/**
 * Через временный файл и rename: две одновременные записи поверх одного файла
 * оставляли хвост прошлого содержимого, и `run.json` переставал читаться.
 */
export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2));
    if (mode) await chmod(tmp, mode);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readJsonl<T>(file: string): Promise<T[]> {
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

export async function chmodShared(file: string): Promise<void> {
  if (!existsSync(file)) return;
  await chmod(file, SHARED_MODE).catch(() => undefined);
}
