import { z } from "zod";
import { InboundEmailSchema } from "./email";
import {
  ServiceCredentialSchema,
  ServiceRecipeSchema,
  ServicesSnapshotSchema,
} from "./services";
import { UsageSummarySchema, UsageTotalsSchema } from "./usage";

/**
 * HTTP между control plane и agent-runtime на машине агента.
 * Все запросы с заголовком `Authorization: Bearer <RUNTIME_TOKEN>`.
 */

export const DeliverEmailRequestSchema = z.object({
  email: InboundEmailSchema,
});

/** Событие Slack, уже проверенное подписью на control plane. */
export const DeliverSlackEventRequestSchema = z.object({
  eventId: z.string().min(1).max(64),
  teamId: z.string().min(1).max(32),
  event: z.object({
    type: z.enum(["message", "app_mention"]),
    channel: z.string().min(1).max(32),
    user: z.string().max(32).optional(),
    text: z.string().max(8000).optional(),
    ts: z.string().min(1).max(32),
    threadTs: z.string().max(32).optional(),
    channelType: z.string().max(32).optional(),
    botId: z.string().max(32).optional(),
    subtype: z.string().max(64).optional(),
  }),
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1),
  /** Кто написал, чтобы runtime знал, что это владелец. */
  author: z.string(),
  /** Нет — runtime заводит новый чат. Есть — сообщение в этот чат и его сессию Hermes. */
  chatId: z.string().optional(),
});

export const UpdateSettingsRequestSchema = z.object({
  autonomous: z.boolean().optional(),
  model: z.string().optional(),
});

export const SyncServicesRequestSchema = z.object({
  snapshot: ServicesSnapshotSchema,
});

export const GoogleTokenRequestSchema = z.object({
  /** Содержимое google_token.json в формате google-workspace скилла Hermes. */
  token: z.record(z.string(), z.unknown()),
});

export const RunStatus = z.enum(["queued", "running", "waiting_approval", "done", "failed", "escalated", "canceled"]);

export const RunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: RunStatus,
  /** Откуда пришла задача. */
  trigger: z.enum(["email", "chat", "cron", "approval"]),
  title: z.string(),
  /** Короткий итог для списка. */
  summary: z.string(),
  threadId: z.string().nullable(),
  /**
   * Миллисекунды, пока задача была в работе.
   * Ожидание человека не входит. Нет поля — старая задача, время считается по началу и концу.
   */
  activeMs: z.number().int().nonnegative().optional(),
  /** Начало текущего отрезка работы. null — пауза или задача ещё в очереди. */
  activeSince: z.string().nullable().optional(),
});

export const RunStepSchema = z.object({
  at: z.string(),
  kind: z.enum(["model", "tool", "mcp", "api", "browser", "email", "note", "error"]),
  text: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const BrowserSessionSchema = z.object({
  id: z.string(),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /** `browserbase` — старые сессии, пока браузер арендовался. Новые свои — `local`. */
  provider: z.enum(["local", "skyvern", "browserbase"]),
  purpose: z.string(),
  hasVideo: z.boolean(),
  /** Живой экран Skyvern, пока сессия открыта. У своего браузера всегда null. */
  liveUrl: z.string().nullable(),
});

export const ChatThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Превью последнего сообщения. */
  lastMessage: z.string().nullable(),
  /** В этом чате сейчас идёт задача. */
  busy: z.boolean(),
  /** `mail` — чат почты и расписания. `channel` — диалог в мессенджере. */
  kind: z.enum(["mail", "channel"]).optional(),
});

export const ChatMessageSchema = z.object({
  at: z.string(),
  role: z.enum(["user", "agent"]),
  text: z.string(),
  runId: z.string().nullable(),
  chatId: z.string(),
  /** Кто написал, если это не владелец в карточке. В журнале показывается вместо «Вы». */
  author: z.string().optional(),
  /**
   * `browser` — карточка сессии браузера: живой экран, пока открыта, потом видео.
   * `approval` — от агента: вопрос с кнопками, пока id есть в `pendingApprovals`;
   * от пользователя: нажатое решение или текст ответа. Нет — обычный текст.
   */
  kind: z.enum(["text", "browser", "approval"]).optional(),
  /** Для `kind: "browser"` — id сессии из `browserSessions`. */
  sessionId: z.string().optional(),
  /** Для `kind: "approval"` — id из `pendingApprovals`. */
  approvalId: z.string().optional(),
  /** Для `kind: "approval"` от пользователя — что нажали. */
  decision: z.enum(["approved", "rejected"]).optional(),
  /** Для `kind: "approval"`: агент застрял в браузере и просит человека доделать, а не одобрить. */
  handoff: z.boolean().optional(),
  /** Варианты ответа, если это вопрос с кнопками, а не «Да»/«Нет». */
  options: z.array(z.string()).optional(),
  /** Заявка ждёт одобрения в сервисе: кнопки без живого браузера. */
  serviceWait: z.boolean().optional(),
  /** Живой экран браузера, где человек может взять управление. */
  liveUrl: z.string().nullable().optional(),
});

export const PendingApprovalSchema = z.object({
  id: z.string(),
  runId: z.string(),
  createdAt: z.string(),
  /** Что именно собираемся изменить. */
  description: z.string(),
  /** Message-ID письма с вопросом, чтобы узнать «да/нет» в ответе. */
  emailMessageId: z.string().nullable(),
  /** Чат, в котором спрашиваем. У старых вопросов может не быть. */
  chatId: z.string().nullable(),
  /** `handoff` — человек доделывает вход в браузере; «да» значит «я доделал». `question` — выбор или текст. */
  kind: z.enum(["approval", "handoff", "question"]).optional(),
  /** Кнопки вопроса. Пусто — только поле ответа. */
  options: z.array(z.string()).optional(),
  liveUrl: z.string().nullable().optional(),
  /** Заявка ждёт одобрения администратора сервиса, браузер уже закрыт. */
  serviceWait: z.boolean().optional(),
});

const ConnectedServiceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["mcp", "api", "browser"]),
  hasCredential: z.boolean(),
  /** Почта, под которой агент зарегистрировался. */
  accountEmail: z.string().nullable().optional(),
  /** Имя, которым агент заполнил регистрацию. */
  accountName: z.string().nullable().optional(),
  hasPassword: z.boolean().optional(),
  /** Есть ли назначенная работа. null — ещё не выяснили. */
  watchesTasks: z.boolean().nullable().optional(),
  /** `messenger` — канал связи, как почта и чат. */
  channel: z.enum(["messenger"]).nullable().optional(),
});

export const RuntimeStateSchema = z.object({
  agentId: z.string(),
  email: z.string(),
  model: z.string(),
  autonomous: z.boolean(),
  busyInBrowser: z.boolean(),
  pendingApprovals: z.array(PendingApprovalSchema),
  runs: z.array(RunSchema),
  /** Чаты без тел сообщений: сообщения грузятся отдельно. */
  chats: z.array(ChatThreadSchema),
  browserSessions: z.array(BrowserSessionSchema),
  usage: UsageSummarySchema,
  /** Сервисы, у которых у тенанта уже есть доступ. */
  connectedServices: z.array(ConnectedServiceSchema),
});

/**
 * События `GET /events`. `asleep`, `waking` и `unreachable` шлёт control plane, не будя машину.
 * `unreachable` — машина запущена, но runtime не отвечает.
 */
export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: RuntimeStateSchema }),
  z.object({ type: z.literal("run"), run: RunSchema }),
  z.object({ type: z.literal("step"), runId: z.string(), step: RunStepSchema }),
  z.object({ type: z.literal("chats"), chats: z.array(ChatThreadSchema) }),
  z.object({ type: z.literal("chatMessage"), chatId: z.string(), message: ChatMessageSchema }),
  z.object({ type: z.literal("approvals"), approvals: z.array(PendingApprovalSchema) }),
  z.object({ type: z.literal("browserSession"), session: BrowserSessionSchema }),
  z.object({ type: z.literal("browserAction"), sessionId: z.string(), action: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("services"), connectedServices: z.array(ConnectedServiceSchema) }),
  z.object({ type: z.literal("sleeping") }),
  z.object({ type: z.literal("asleep") }),
  z.object({ type: z.literal("waking") }),
  z.object({ type: z.literal("unreachable") }),
]);

export type DeliverEmailRequest = z.infer<typeof DeliverEmailRequestSchema>;
export type DeliverSlackEventRequest = z.infer<typeof DeliverSlackEventRequestSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
export type SyncServicesRequest = z.infer<typeof SyncServicesRequestSchema>;
export type GoogleTokenRequest = z.infer<typeof GoogleTokenRequestSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunStatus = z.infer<typeof RunStatus>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type ChatThread = z.infer<typeof ChatThreadSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type PendingApproval = z.infer<typeof PendingApprovalSchema>;
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/**
 * Что runtime сообщает обратно control plane, когда нашёл новый способ входа
 * или вошёл в сервис. Эндпоинт в web: `POST /api/runtime/report`.
 */
export const RuntimeReportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recipe"), recipe: ServiceRecipeSchema, runId: z.string().optional() }),
  z.object({ type: z.literal("credential"), credential: ServiceCredentialSchema, runId: z.string().optional() }),
]);

export type RuntimeReport = z.infer<typeof RuntimeReportSchema>;

/**
 * Просьба усыпить машину: `POST /api/runtime/suspend`. Вместе с ней runtime
 * отдаёт итоги `usage.jsonl`, чтобы расходы спящего агента были видны без пробуждения.
 * Старый runtime шлёт пустое тело.
 */
export const SuspendRequestSchema = z.object({
  usage: UsageTotalsSchema.optional(),
});

export type SuspendRequest = z.infer<typeof SuspendRequestSchema>;
