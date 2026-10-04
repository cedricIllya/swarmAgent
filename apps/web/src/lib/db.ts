import { getDb } from "@swarm/db";
import { env } from "@/env";

export function db() {
  return getDb(env.databaseUrl);
}
