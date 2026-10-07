import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const membershipRole = pgEnum("membership_role", ["owner", "admin", "member"]);
export const agentStatus = pgEnum("agent_status", [
  "creating",
  "provisioning",
  "running",
  "stopped",
  "failed",
  "deleting",
]);
export const accessKind = pgEnum("access_kind", ["mcp", "api", "browser"]);

/** Организация. Все данные, кроме каталога рецептов, живут под тенантом. */
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Свой receiving-домен у того же Mailgun. Пусто — берём AGENTS_DOMAIN. */
  agentsDomain: text("agents_domain"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Таблицы better-auth: user, session, account, verification.
 * Имена полей — те, что better-auth ждёт по умолчанию.
 */
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Текущий тенант сессии. */
    activeTenantId: text("active_tenant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Кто в каком тенанте. Один человек — в нескольких тенантах, тенант — с несколькими людьми. */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_idx").on(t.tenantId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Имя, которым агент заполняет first name. У старых агентов пусто — берётся из `name`. */
    firstName: text("first_name"),
    /** Фамилия для last name. У старых агентов пусто. */
    lastName: text("last_name"),
    model: text("model").notNull(),
    /** Голая локальная часть без плюс-тега, нижний регистр. */
    localPart: text("local_part").notNull(),
    domain: text("domain").notNull(),
    status: agentStatus("status").notNull().default("creating"),
    statusMessage: text("status_message"),
    autonomous: boolean("autonomous").notNull().default(false),
    flyAppName: text("fly_app_name"),
    flyMachineId: text("fly_machine_id"),
    flyVolumeId: text("fly_volume_id"),
    /** Приватный адрес runtime: http://<app>.flycast:8787. Старые записи — .internal. */
    runtimeUrl: text("runtime_url"),
    /** SHA коммита, образ которого стоит на машине. Пусто — машина поднята до учёта релизов. */
    runtimeRelease: text("runtime_release"),
    /** Bearer, которым control plane ходит в runtime. Зашифрован. */
    runtimeTokenEnc: text("runtime_token_enc"),
    /** Google refresh token этого агента. Зашифрован. */
    googleRefreshTokenEnc: text("google_refresh_token_enc"),
    googleEmail: text("google_email"),
    /** Аватар: `nice:` и JSON конфига конструктора. Пусто — инициалы. */
    avatar: text("avatar"),
    /**
     * Итоги `usage.jsonl` на момент, когда машина последний раз отчиталась
     * (перед сном или когда control plane читал `/state`). Пусто — ещё ни разу.
     */
    usageCostUsd: doublePrecision("usage_cost_usd"),
    usagePromptTokens: bigint("usage_prompt_tokens", { mode: "number" }),
    usageCompletionTokens: bigint("usage_completion_tokens", { mode: "number" }),
    usageAt: timestamp("usage_at", { withTimezone: true }),
    /**
     * Плановую проверку не будить раньше этого времени: несколько пустых обходов подряд.
     * Письмо, чат и мессенджер сбрасывают. Пусто — обычные 15 минут.
     */
    tickQuietUntil: timestamp("tick_quiet_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agents_address_idx").on(t.localPart, t.domain),
    index("agents_tenant_idx").on(t.tenantId),
  ],
);

/**
 * Общий каталог способов входа. Без tenant_id и без секретов.
 * Первый агент любого клиента, встретивший сервис, пишет сюда.
 */
export const serviceRecipes = pgTable("service_recipes", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  kind: accessKind("kind").notNull(),
  domains: jsonb("domains").$type<string[]>().notNull().default([]),
  mcp: jsonb("mcp").$type<Record<string, unknown> | null>(),
  api: jsonb("api").$type<Record<string, unknown> | null>(),
  browser: jsonb("browser").$type<Record<string, unknown> | null>(),
  notes: text("notes").notNull().default(""),
  /** true — в сервисе есть назначенная работа; false — смотреть задачи не нужно; null — ещё не выяснили. */
  watchesTasks: boolean("watches_tasks"),
  /** `messenger` — канал связи. Плановую проверку задач не включает, машину для чтения сообщений будит. */
  channel: text("channel").$type<"messenger" | null>(),
  discoveredByAgentId: text("discovered_by_agent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Секрет агента для сервиса из каталога. Доступ принадлежит тому агенту, который вошёл:
 * соседи по тенанту его не видят. tenant_id — для учёта и каскадного удаления. Тело зашифровано.
 */
export const serviceCredentials = pgTable(
  "service_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    slug: text("slug")
      .notNull()
      .references(() => serviceRecipes.slug, { onDelete: "cascade" }),
    kind: accessKind("kind").notNull(),
    /** Зашифрованный JSON ServiceCredential без slug/kind и без externalKey. */
    secretEnc: text("secret_enc").notNull(),
    accountEmail: text("account_email"),
    /** Id установки снаружи. У Slack — id команды, по нему приходит webhook. */
    externalKey: text("external_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_credentials_agent_slug_idx").on(t.agentId, t.slug),
    uniqueIndex("service_credentials_slug_external_idx").on(t.slug, t.externalKey),
    index("service_credentials_tenant_idx").on(t.tenantId),
  ],
);
