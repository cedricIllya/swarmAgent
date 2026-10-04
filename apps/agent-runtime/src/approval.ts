import type { InboundEmail } from "@swarm/contracts";

const YES = new Set(["да", "yes", "ок", "ok", "okay", "ага", "давай", "подтверждаю", "approve", "approved", "y"]);
const NO = new Set(["нет", "no", "отмена", "отменить", "cancel", "stop", "стоп", "n"]);

export type ReplyVerdict = "approve" | "reject" | "task";

function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Читается словами, не моделью: «да» — это разница между чтением и изменением
 * чужого продукта. Сравниваем всё письмо целиком после нижнего регистра и
 * снятия пунктуации. Что длиннее — новая задача в той же ветке.
 */
export function classifyReply(replyText: string): ReplyVerdict {
  const w = normalizeWord(replyText);
  if (w.length === 0) return "task";
  if (YES.has(w)) return "approve";
  if (NO.has(w)) return "reject";
  return "task";
}

/** Какое из писем агента цитирует этот ответ. */
export function matchesThread(
  email: Pick<InboundEmail, "inReplyTo" | "references">,
  sentMessageIds: Iterable<string>,
): string | null {
  const sent = new Set(sentMessageIds);
  if (email.inReplyTo && sent.has(email.inReplyTo)) return email.inReplyTo;
  for (const r of email.references) if (sent.has(r)) return r;
  return null;
}

/** 4–8 цифр отдельным словом: одноразовый код. */
export function findDigitCode(text: string): string | null {
  const m = text.match(/(?<![\d-])(\d{4,8})(?![\d-])/);
  return m?.[1] ?? null;
}
