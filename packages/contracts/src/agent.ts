import { z } from "zod";

export const AgentStatus = z.enum([
  "creating",
  "provisioning",
  "running",
  "stopped",
  "failed",
  "deleting",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  /** Имя для форм регистрации. Пусто у агентов, созданных одним полем. */
  firstName: z.string().nullable(),
  /** Фамилия для форм регистрации. Пусто у агентов, созданных одним полем. */
  lastName: z.string().nullable(),
  model: z.string(),
  localPart: z.string(),
  domain: z.string(),
  email: z.string(),
  status: AgentStatus,
  statusMessage: z.string().nullable(),
  /** Разрешать все действия без человека. По умолчанию выключено. */
  autonomous: z.boolean(),
  flyAppName: z.string().nullable(),
  flyMachineId: z.string().nullable(),
  /** Приватный URL runtime внутри сети Fly. */
  runtimeUrl: z.string().nullable(),
  googleConnected: z.boolean(),
  /** Google-аккаунт, под которым агент вошёл. Пусто, пока Google не подключён. */
  googleEmail: z.string().nullable(),
  /** Собранный аватар: `nice:` и JSON конфига. Пусто — инициалы. */
  avatar: z.string().nullable(),
  createdAt: z.string(),
});

export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentInputSchema = z.object({
  firstName: z.string().trim().min(1).max(40),
  lastName: z.string().trim().min(1).max(40),
  model: z.string().min(1),
  domain: z.string().optional(),
});

export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

/** Верхняя граница строки конфига аватара. */
export const AGENT_AVATAR_MAX = 4_000;

const NICE_PREFIX = "nice:";
const Hex = z.string().regex(/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/);

/** Конфиг react-nice-avatar. Хранится целиком, чтобы лицо не пересобиралось случайно. */
export const CreatedAvatarSchema = z.object({
  sex: z.enum(["man", "woman"]),
  faceColor: Hex,
  earSize: z.enum(["small", "big"]),
  hairColor: Hex,
  hairStyle: z.enum(["normal", "thick", "mohawk", "womanLong", "womanShort"]),
  hatColor: Hex,
  hatStyle: z.enum(["beanie", "turban", "none"]),
  eyeStyle: z.enum(["circle", "oval", "smile"]),
  eyeBrowStyle: z.enum(["up", "upWoman"]),
  glassesStyle: z.enum(["round", "square", "none"]),
  noseStyle: z.enum(["short", "long", "round"]),
  mouthStyle: z.enum(["laugh", "smile", "peace"]),
  shirtStyle: z.enum(["hoody", "short", "polo"]),
  shirtColor: Hex,
  bgColor: Hex,
});

export type CreatedAvatar = z.infer<typeof CreatedAvatarSchema>;

export function encodeCreatedAvatar(config: CreatedAvatar): string {
  return `${NICE_PREFIX}${JSON.stringify(CreatedAvatarSchema.parse(config))}`;
}

export function parseCreatedAvatar(value: string | null | undefined): CreatedAvatar | null {
  if (!value?.startsWith(NICE_PREFIX)) return null;
  try {
    const parsed = CreatedAvatarSchema.safeParse(JSON.parse(value.slice(NICE_PREFIX.length)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isCreatedAvatar(value: string): boolean {
  return parseCreatedAvatar(value) !== null;
}

export const AgentAvatarSchema = z
  .string()
  .max(AGENT_AVATAR_MAX)
  .refine(isCreatedAvatar, "нужен собранный аватар");
