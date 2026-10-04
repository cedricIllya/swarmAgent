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
  createdAt: z.string(),
});

export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentInputSchema = z.object({
  name: z.string().min(1).max(80),
  model: z.string().min(1),
  localPart: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "Только буквы, цифры, точки, дефисы, подчёркивания")
    .optional(),
  domain: z.string().optional(),
});

export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;
