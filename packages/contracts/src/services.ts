import { z } from "zod";

export const AccessKind = z.enum(["mcp", "api", "browser"]);
export type AccessKind = z.infer<typeof AccessKind>;

/**
 * Способ входа в сервис. Один на весь продукт, без секретов и без тенанта.
 * Любой клиент читает его, первый встретивший сервис агент его пишет.
 */
export const ServiceRecipeSchema = z.object({
  /** Стабильный ключ: `linear`, `notion`, `github`. */
  slug: z.string(),
  name: z.string(),
  kind: AccessKind,
  /** Домены сервиса, по ним письмо и инвайт сопоставляются с рецептом. */
  domains: z.array(z.string()),
  mcp: z
    .object({
      url: z.string().url(),
      transport: z.enum(["streamable_http", "sse"]).default("streamable_http"),
      auth: z.enum(["none", "bearer", "oauth"]).default("bearer"),
      /** Какие инструменты вообще стоит показывать агенту. Пусто — все. */
      includeTools: z.array(z.string()).default([]),
    })
    .optional(),
  api: z
    .object({
      baseUrl: z.string().url(),
      docsUrl: z.string().url().optional(),
      auth: z.enum(["bearer", "basic", "header", "oauth"]).default("bearer"),
      authHeader: z.string().default("Authorization"),
    })
    .optional(),
  browser: z
    .object({
      loginUrl: z.string().url(),
      appUrl: z.string().url(),
    })
    .optional(),
  /** Что уже выяснили о сервисе словами, чтобы следующий агент не искал заново. */
  notes: z.string().default(""),
  discoveredBy: z.string().nullable().default(null),
});

export type ServiceRecipe = z.infer<typeof ServiceRecipeSchema>;

function hostOnDomains(url: string, domains: string[]): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const root = domain.toLowerCase();
    return host === root || host.endsWith(`.${root}`);
  });
}

/**
 * API, браузер и MCP рецепта остаются, только если их хост — домен этого сервиса.
 * Страница другого продукта (GitVerse для Gensite) в каталог не попадает.
 * Заметки после такой чистки сохраняют только фразы со ссылкой на свой домен.
 */
export function withoutForeignEndpoints(recipe: ServiceRecipe): ServiceRecipe {
  if (!recipe.domains.length) return recipe;
  const ok = (url: string | undefined) => !url || hostOnDomains(url, recipe.domains);
  const mcp = recipe.mcp && ok(recipe.mcp.url) ? recipe.mcp : undefined;
  const api = recipe.api && ok(recipe.api.baseUrl) && ok(recipe.api.docsUrl) ? recipe.api : undefined;
  const browser = recipe.browser && ok(recipe.browser.loginUrl) && ok(recipe.browser.appUrl) ? recipe.browser : undefined;
  const dropped = mcp !== recipe.mcp || api !== recipe.api || browser !== recipe.browser;
  const notes = dropped
    ? recipe.notes
        .split(/(?<=\.)\s+/)
        .filter((sentence) => {
          const urls = [...sentence.matchAll(/https?:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,;]+$/, ""));
          return urls.length > 0 && urls.every((url) => hostOnDomains(url, recipe.domains));
        })
        .join(" ")
    : recipe.notes;
  return { ...recipe, mcp, api, browser, notes };
}

/**
 * Секрет агента для сервиса из каталога. Принадлежит тому агенту, который вошёл,
 * и уходит только на его машину уже расшифрованным.
 */
export const ServiceCredentialSchema = z.object({
  slug: z.string(),
  kind: AccessKind,
  /** API-ключ или bearer для MCP. null в отчёте — токен отозван, убрать сохранённый. */
  token: z.string().nullable().optional(),
  oauth: z
    .object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      expiresAt: z.string().optional(),
      scope: z.string().optional(),
    })
    .optional(),
  /** Playwright storage state после входа в браузере. */
  storageState: z.unknown().optional(),
  /** Логин аккаунта сервиса, который завёл агент. */
  accountEmail: z.string().optional(),
  /** Имя, которым агент заполнил регистрацию. */
  accountName: z.string().optional(),
  /** Пароль аккаунта, который агент сам задал при регистрации по приглашению. */
  password: z.string().optional(),
});

export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

/**
 * Поздний отчёт (например, только токен) не затирает уже сохранённый вход:
 * почту, имя и пароль, под которыми агент зарегистрировался.
 */
export function mergeCredential(prev: ServiceCredential | undefined, next: ServiceCredential): ServiceCredential {
  if (!prev) return dropNullToken(next);
  return dropNullToken({
    ...prev,
    ...next,
    token: next.token === null ? null : (next.token ?? prev.token),
    oauth: next.oauth ?? prev.oauth,
    storageState: next.storageState ?? prev.storageState,
    accountEmail: next.accountEmail ?? prev.accountEmail,
    accountName: next.accountName ?? prev.accountName,
    password: next.password ?? prev.password,
  });
}

function dropNullToken(cred: ServiceCredential): ServiceCredential {
  if (cred.token !== null) return cred;
  const { token: _token, ...rest } = cred;
  return rest;
}

/**
 * Что control plane кладёт на машину агента как `services.json`:
 * весь общий каталог и секреты только этого агента.
 */
export const ServicesSnapshotSchema = z.object({
  generatedAt: z.string(),
  recipes: z.array(ServiceRecipeSchema),
  credentials: z.array(ServiceCredentialSchema),
});

export type ServicesSnapshot = z.infer<typeof ServicesSnapshotSchema>;
