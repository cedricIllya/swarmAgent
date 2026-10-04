import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error("DATABASE_URL не задан");
  process.exit(1);
}
// Приложение ходит через PgBouncer. Миграции берут прямой хост: advisory lock
// в transaction pooling не держится.
const url = rawUrl.replace("@pgbouncer.", "@direct.");

const folder = process.env.MIGRATIONS_FOLDER ?? fileURLToPath(new URL("../drizzle", import.meta.url));
const needsSsl = url.includes("flympg.net") || /sslmode=require/.test(url);
const client = postgres(url, { max: 1, prepare: false, ...(needsSsl ? { ssl: "require" as const } : {}) });
await migrate(drizzle(client), { migrationsFolder: folder });
await client.end();
console.log("migrations applied");
