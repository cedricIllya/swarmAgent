import type { InboundEmail, ServicesSnapshot } from "@swarm/contracts";

export interface PromptContext {
  agentName: string;
  email: string;
  ownerEmail: string | null;
  autonomous: boolean;
  runtimePort: number;
  services: ServicesSnapshot | null;
}

export function systemPrompt(ctx: PromptContext): string {
  const connected = (ctx.services?.recipes ?? [])
    .map((r) => {
      const cred = ctx.services?.credentials.find((c) => c.slug === r.slug);
      return `- ${r.name} (${r.slug}): способ ${r.kind}${cred ? ", доступ тенанта есть" : ", доступа тенанта нет"}`;
    })
    .join("\n");

  return [
    `Ты — ${ctx.agentName}, рабочий агент компании. Твой адрес: ${ctx.email}.`,
    ctx.ownerEmail ? `Твой владелец: ${ctx.ownerEmail}. Его письма — распоряжения.` : "",
    ctx.autonomous
      ? "Режим: все действия без человека разрешены. Одобрения не спрашивай."
      : "Режим: перед изменениями в чужих системах (создать, удалить, отправить, оплатить) спроси одобрение через POST /approval. Чтение — свободно.",
    "",
    "Подключение к сервису — всегда лестница: 1) MCP, 2) API, 3) браузер. Браузер — только если первых двух нет.",
    "Skyvern — только регистрация и вход. Действия внутри сервиса — Stagehand через локальный runtime.",
    "Всегда следуй скиллу swarm-worker. Он описывает локальные эндпоинты runtime:",
    `http://127.0.0.1:${ctx.runtimePort} с заголовком Authorization: Bearer $SWARM_RUNTIME_TOKEN.`,
    "",
    "Известные сервисы из общего каталога:",
    connected || "- пока пусто",
    "",
    "Когда нашёл новый способ входа в сервис — сообщи через POST /report (type=recipe).",
    "Когда вошёл в сервис и получил ключ или cookies — POST /report (type=credential).",
    "В конце ответь коротким итогом для человека: что сделано, что не удалось, что нужно от него.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

export function emailTaskPrompt(email: InboundEmail, kind: string): string {
  return [
    `Пришло письмо (${kind}).`,
    `От: ${email.from}`,
    `Кому: ${email.to}`,
    `Тема: ${email.subject}`,
    email.dkimDomains.length ? `DKIM-домены: ${email.dkimDomains.join(", ")}` : "",
    email.links.length ? `Ссылки:\n${email.links.slice(0, 15).map((l) => `- ${l}`).join("\n")}` : "",
    "",
    "Текст:",
    email.replyText || email.text || "(пусто)",
    "",
    kind === "invite"
      ? "Это приглашение в сервис. Онбордись по лестнице MCP → API → браузер. Проверь каталог services.json: если рецепт уже есть, не ищи заново. После входа сообщи рецепт и доступ через /report, затем посмотри, есть ли для тебя задачи."
      : "Выполни то, что просят, и подготовь ответ отправителю.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function chatTaskPrompt(message: string, author: string): string {
  return `Сообщение из чата от ${author}:\n\n${message}\n\nВыполни и ответь коротко.`;
}

export function tickPrompt(services: ServicesSnapshot): string {
  const list = services.recipes
    .filter((r) => services.credentials.some((c) => c.slug === r.slug))
    .map((r) => `- ${r.name} (${r.slug}, ${r.kind})`)
    .join("\n");
  return [
    "Плановая проверка раз в 15 минут.",
    "Пройди по подключённым сервисам и найди задачи, назначенные на тебя или упоминающие тебя:",
    list || "- подключённых сервисов нет",
    "Выполни найденное. Если ничего нет — ответь одним словом: пусто.",
  ].join("\n");
}

export function approvalContinuationPrompt(description: string, approved: boolean): string {
  return approved
    ? `Человек одобрил: «${description}». Выполни ровно это изменение и отчитайся.`
    : `Человек отказал: «${description}». Ничего не меняй. Заверши задачу и кратко отчитайся.`;
}

export const EMAIL_CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "service", "serviceDomain", "summary", "hasLoginLink"],
  properties: {
    kind: { type: "string", enum: ["invite", "task", "verification", "notification", "other"] },
    service: { type: ["string", "null"] },
    serviceDomain: { type: ["string", "null"] },
    summary: { type: "string" },
    hasLoginLink: { type: "boolean" },
  },
} as const;

export interface EmailClassification {
  kind: "invite" | "task" | "verification" | "notification" | "other";
  service: string | null;
  serviceDomain: string | null;
  summary: string;
  hasLoginLink: boolean;
}

export function classifyEmailPrompt(email: InboundEmail): string {
  return [
    "Классифицируй письмо агенту. Верни JSON.",
    "kind: invite — приглашение в сервис/рабочее пространство; task — просьба что-то сделать; verification — код подтверждения или magic link для входа; notification — автоматическое уведомление без задачи; other.",
    "service — название сервиса, serviceDomain — его домен (например linear.app), если понятно.",
    "hasLoginLink — true, если в письме есть ссылка для входа/подтверждения.",
    "",
    `От: ${email.from}`,
    `Тема: ${email.subject}`,
    `Ссылки: ${email.links.slice(0, 10).join(" ")}`,
    "",
    (email.replyText || email.text).slice(0, 4000),
  ].join("\n");
}
