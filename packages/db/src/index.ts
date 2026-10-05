import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";
export { eq, ne, and, or, desc, asc, sql, inArray, isNull } from "drizzle-orm";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: Db | null = null;

/**
 * Один клиент на процесс. `DATABASE_URL` есть только у control plane;
 * runtime этот пакет не импортирует.
 */
export function getDb(url = process.env.DATABASE_URL): Db {
  if (cached) return cached;
  if (!url) {
    throw new Error("DATABASE_URL не задан");
  }
  const client = postgres(url, postgresOptions(url, 10));
  cached = drizzle(client, { schema });
  return cached;
}

/** PgBouncer у Fly MPG не держит prepared statements и требует TLS. */
export function postgresOptions(url: string, max: number): { max: number; prepare: false; ssl?: "require" } {
  const needsSsl = url.includes("flympg.net") || /sslmode=require/.test(url);
  return { max, prepare: false, ...(needsSsl ? { ssl: "require" as const } : {}) };
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return `${prefix}_${out.slice(0, 20)}`;
}
