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
  /**
   * Сервис для задач, который надо обходить по расписанию.
   * true — доски, карточки, тикеты, issues. Ставится один раз и не снимается, даже если сейчас задач нет.
   * false — сервис не для задач: оплата, ключи, хостинг. Открывать только по прямой просьбе.
   * Нет значения — ещё не выяснили, в плановую проверку не берём.
   * У мессенджера всегда false: это канал связи, а не доска задач.
   */
  watchesTasks: z.boolean().nullable().optional(),
  /**
   * `messenger` — сюда пишут люди, как на почту и в чат карточки.
   * Ответ уходит в тот же диалог. Плановая проверка задачи здесь не ищет.
   */
  channel: z.enum(["messenger"]).nullable().optional(),
  discoveredBy: z.string().nullable().default(null),
});

export type ServiceRecipe = z.infer<typeof ServiceRecipeSchema>;

/** Домены и короткие имена, по которым сервис — мессенджер, даже до записи `channel`. */
export const MESSENGER_DOMAINS = ["slack.com", "telegram.org", "t.me", "discord.com", "discordapp.com", "whatsapp.com"] as const;
export const MESSENGER_SLUGS = ["slack", "telegram", "discord", "whatsapp"] as const;

export const MESSENGER_NOTE =
  "Канал связи: как почта и чат. Люди пишут сюда агенту, ответ уходит в тот же диалог. Назначенные задачи не искать.";

const WORK_GUIDE_MARK = "Как работать:";

function hostOfDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]?.split(":")[0] ?? "";
}

/** Slack, Telegram и другие переписки. Не доска задач. */
export function isMessengerRecipe(recipe: {
  slug?: string | undefined;
  channel?: "messenger" | null | undefined;
  domains?: string[] | undefined;
}): boolean {
  if (recipe.channel === "messenger") return true;
  if (recipe.slug && (MESSENGER_SLUGS as readonly string[]).includes(recipe.slug)) return true;
  return (recipe.domains ?? []).some((domain) => {
    const host = hostOfDomain(domain);
    return MESSENGER_DOMAINS.some((root) => host === root || host.endsWith(`.${root}`));
  });
}

/** Slack умеем читать и отвечать сами. Остальные мессенджеры пока только помечены как канал. */
export function messengerAdapter(recipe: { slug?: string | undefined; domains?: string[] | undefined }): "slack" | null {
  if (recipe.slug === "slack") return "slack";
  const hosts = (recipe.domains ?? []).map(hostOfDomain);
  if (hosts.some((host) => host === "slack.com" || host.endsWith(".slack.com"))) return "slack";
  return null;
}

/**
 * Мессенджер — канал связи. Снимает карту «как работать с задачами»
 * и больше не отдаёт его в плановую проверку.
 */
export function messengerPatch<T extends ServiceRecipe>(recipe: T): T {
  if (!isMessengerRecipe(recipe)) return recipe;
  const at = recipe.notes.indexOf(WORK_GUIDE_MARK);
  const base = (at < 0 ? recipe.notes : recipe.notes.slice(0, at)).trim();
  const notes = base.includes("Канал связи:") ? base : `${base} ${MESSENGER_NOTE}`.trim();
  return { ...recipe, channel: "messenger", watchesTasks: false, notes: notes.slice(0, 1200) };
}

/**
 * Повторный отчёт без этого поля не стирает уже решённую классификацию.
 * Сервис, однажды помеченный как сервис для задач, с обхода не снимается.
 * Мессенджер сюда не доходит: его вызывающий код заранее ставит false.
 */
export function keepWatchesTasks(
  prev: boolean | null | undefined,
  next: boolean | null | undefined,
): boolean | null {
  if (prev === true) return true;
  if (typeof next === "boolean") return next;
  return typeof prev === "boolean" ? prev : null;
}

/** Мессенджер, однажды узнанный, повторным отчётом не снимается. */
export function keepChannel(
  prev: "messenger" | null | undefined,
  next: "messenger" | null | undefined,
): "messenger" | null {
  if (next === "messenger" || prev === "messenger") return "messenger";
  return null;
}

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
  /**
   * Внешний ключ установки, по которому webhook находит агента.
   * У Slack это id пользователя. В шифрованное тело не кладётся — только в колонку.
   */
  externalKey: z.string().min(1).max(64).optional(),
  /**
   * Страница списка назначенных задач этого аккаунта.
   * Плановая проверка открывает её сразу и не ищет список по меню.
   */
  tasksUrl: z.string().url().optional(),
  /**
   * Отпечаток прошлого списка. Пока текст страницы или ответ вызова тот же,
   * плановая проверка не зовёт модель.
   */
  tasksDigest: z.string().min(16).max(128).optional(),
  /**
   * Вызов, которым читается список задач API или MCP.
   * Секрет в него не кладётся: токен runtime подставляет сам.
   */
  tasksCall: z
    .object({
      kind: z.enum(["api", "mcp"]),
      method: z.enum(["GET", "POST"]).optional(),
      url: z.string().url().optional(),
      body: z.string().max(4000).optional(),
      tool: z.string().max(120).optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
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
    externalKey: next.externalKey ?? prev.externalKey,
    tasksUrl: next.tasksUrl || prev.tasksUrl,
    tasksDigest: next.tasksDigest || prev.tasksDigest,
    tasksCall: next.tasksCall ?? prev.tasksCall,
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
