import { createAuth, type Auth } from "@swarm/identity";
import { env } from "@/env";

let cached: Auth | null = null;

export function auth(): Auth {
  if (!cached) {
    cached = createAuth({ secret: env.authSecret, baseURL: env.appUrl, databaseUrl: env.databaseUrl });
  }
  return cached;
}
