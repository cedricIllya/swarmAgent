import { z } from "zod";

/**
 * Одна нормализованная форма письма. В неё сводятся и form-urlencoded
 * (Mailgun Routes), и JSON (Postmark и подобные).
 */
export const InboundEmailSchema = z.object({
  /** SMTP envelope sender (MAIL FROM). */
  sender: z.string(),
  /** Заголовок From, как его видит получатель. Отдельно от envelope. */
  from: z.string(),
  /** Адрес получателя, по которому ищем агента. */
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  /** Заголовки: ключ в нижнем регистре, первое значение. */
  headers: z.record(z.string(), z.string()),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  /** Не больше 20 id. */
  references: z.array(z.string()).max(20),
  /** Домены из `d=` каждой DKIM-Signature. */
  dkimDomains: z.array(z.string()),
  /** Тело без цитаты предыдущих писем. */
  replyText: z.string(),
  /** URL всех ссылок из HTML (скрипты выкинуты). */
  links: z.array(z.string()),
  spf: z.string().nullable(),
  dkim: z.string().nullable(),
  receivedAt: z.string(),
});

export type InboundEmail = z.infer<typeof InboundEmailSchema>;

export const OutboundEmailSchema = z.object({
  to: z.string(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
});

export type OutboundEmail = z.infer<typeof OutboundEmailSchema>;
