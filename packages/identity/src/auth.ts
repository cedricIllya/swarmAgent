import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { getDb, newId, schema } from "@swarm/db";
import { originsFromRequest } from "./origins";
import { ensurePersonalTenant } from "./tenants";

export interface AuthOptions {
  secret: string;
  baseURL: string;
  /**
   * Хосты помимо baseURL, которым можно доверять всегда.
   * Origin текущего запроса добавляется отдельно, если его host совпал с Host.
   */
  trustedOrigins?: string[] | ((request?: Request) => string[] | Promise<string[]>) | undefined;
  databaseUrl?: string | undefined;
  /** Доставить ссылку сброса пароля. `url` ведёт на /api/auth и редиректит на страницу нового пароля. */
  sendResetPassword?: (data: { email: string; name: string; url: string }) => Promise<void>;
  /**
   * Снести всё, что принадлежит пользователю, до удаления его записи: тенанты, агентов, машины.
   * Если бросит исключение — пользователь остаётся, а текст ошибки уходит клиенту.
   */
  beforeDeleteUser?: (user: { id: string; email: string; name: string }) => Promise<void>;
}

/**
 * better-auth с email/паролем поверх таблиц из @swarm/db.
 * При регистрации пользователю сразу заводится личный тенант,
 * чтобы главная открывалась без лишних шагов.
 * Удаление аккаунта — через /delete-user без повторного пароля:
 * freshAge 0, хватает текущей сессии.
 */
export function createAuth(opts: AuthOptions) {
  const db = getDb(opts.databaseUrl);
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: async (request) => {
      const configured = opts.trustedOrigins;
      const extra = typeof configured === "function" ? await configured(request) : (configured ?? []);
      return originsFromRequest(request, extra);
    },
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
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(opts.sendResetPassword
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
              // Не ждём отправку: по времени ответа нельзя понять, есть ли такой email.
              void opts.sendResetPassword!({ email: user.email, name: user.name, url }).catch((e) =>
                console.warn(`[auth] письмо сброса пароля: ${e instanceof Error ? e.message : String(e)}`),
              );
            },
          }
        : {}),
    },
    session: {
      // Иначе /delete-user просит пароль, когда сессии больше суток.
      freshAge: 0,
      additionalFields: {
        activeTenantId: { type: "string", required: false, input: false },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          if (!opts.beforeDeleteUser) return;
          try {
            await opts.beforeDeleteUser({ id: user.id, email: user.email, name: user.name });
          } catch (e) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: e instanceof Error ? e.message : String(e),
            });
          }
        },
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
