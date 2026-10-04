import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb, newId, schema } from "@swarm/db";
import { ensurePersonalTenant } from "./tenants";

export interface AuthOptions {
  secret: string;
  baseURL: string;
  databaseUrl?: string | undefined;
}

/**
 * better-auth с email/паролем поверх таблиц из @swarm/db.
 * При регистрации пользователю сразу заводится личный тенант,
 * чтобы главная открывалась без лишних шагов.
 */
export function createAuth(opts: AuthOptions) {
  const db = getDb(opts.databaseUrl);
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      additionalFields: {
        activeTenantId: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensurePersonalTenant(db, { id: user.id, name: user.name }, newId);
          },
        },
      },
    },
    advanced: {
      database: { generateId: () => newId("usr") },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
