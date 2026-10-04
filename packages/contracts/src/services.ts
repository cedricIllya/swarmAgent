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

/**
 * Секрет тенанта для сервиса из каталога. На машину агента уходит уже расшифрованным.
 */
export const ServiceCredentialSchema = z.object({
  slug: z.string(),
  kind: AccessKind,
  /** API-ключ или bearer для MCP. */
  token: z.string().optional(),
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
});

export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

/**
 * Что control plane кладёт на машину агента как `services.json`:
 * весь общий каталог и секреты только его тенанта.
 */
export const ServicesSnapshotSchema = z.object({
  generatedAt: z.string(),
  recipes: z.array(ServiceRecipeSchema),
  credentials: z.array(ServiceCredentialSchema),
});

export type ServicesSnapshot = z.infer<typeof ServicesSnapshotSchema>;
