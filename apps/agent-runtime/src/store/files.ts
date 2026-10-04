import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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

export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
  if (mode) await chmod(file, mode);
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
