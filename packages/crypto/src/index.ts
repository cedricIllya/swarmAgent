import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";

function loadKey(raw = process.env.SECRETS_KEY): Buffer {
  if (!raw) throw new Error("SECRETS_KEY не задан");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY должен быть 32 байта в base64");
  return key;
}

/** `v1.<iv>.<tag>.<ciphertext>` в base64url. */
export function encryptString(plain: string, key = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptString(payload: string, key = loadKey()): string {
  const [v, ivB, tagB, encB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || !encB) throw new Error("Неверный формат шифртекста");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown, key?: Buffer): string {
  return encryptString(JSON.stringify(value), key);
}

export function decryptJson<T>(payload: string, key?: Buffer): T {
  return JSON.parse(decryptString(payload, key)) as T;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Сравнение по байтам: не-ASCII и разная длина не роняют запрос. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
