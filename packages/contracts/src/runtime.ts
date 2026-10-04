import { z } from "zod";
import { InboundEmailSchema } from "./email";
import {
  ServiceCredentialSchema,
  ServiceRecipeSchema,
  ServicesSnapshotSchema,
} from "./services";
import { UsageSummarySchema } from "./usage";

/**
 * HTTP между control plane и agent-runtime на машине агента.
 * Все запросы с заголовком `Authorization: Bearer <RUNTIME_TOKEN>`.
 */

export const DeliverEmailRequestSchema = z.object({
  email: InboundEmailSchema,
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

export const RunStatus = z.enum(["queued", "running", "waiting_approval", "done", "failed"]);

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
  provider: z.enum(["browserbase", "skyvern"]),
  purpose: z.string(),
  hasVideo: z.boolean(),
  /** Browserbase Live View, пока сессия открыта. После закрытия — null. */
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
});

export const ChatMessageSchema = z.object({
  at: z.string(),
  role: z.enum(["user", "agent"]),
  text: z.string(),
  runId: z.string().nullable(),
  chatId: z.string(),
  /** `browser` — карточка сессии браузера: живой экран, пока открыта, потом видео. Нет — обычный текст. */
  kind: z.enum(["text", "browser"]).optional(),
  /** Для `kind: "browser"` — id сессии из `browserSessions`. */
  sessionId: z.string().optional(),
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
 * События `GET /events`. `asleep` и `waking` шлёт control plane, не будя машину.
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
]);

export type DeliverEmailRequest = z.infer<typeof DeliverEmailRequestSchema>;
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
