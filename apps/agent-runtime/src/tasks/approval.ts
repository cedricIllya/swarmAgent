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

/**
 * 4–8 цифр одноразового кода. Atlassian/Trello часто шлют код с пробелами
 * («4 8 2 9 1 3») или в теме («482913 is your verification code»).
 */
export function findDigitCode(text: string): string | null {
  const asCode = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 4 && digits.length <= 8 ? digits : null;
  };

  const nearKeyword = [
    /(?:verification\s+code|one[-\s]?time(?:\s+pass(?:code|word))?|passcode|\botp\b|код(?:\s+подтверждения)?|подтверждени[ея]|verify(?:ing)?(?:\s+it'?s\s+you)?)[^\d\n]{0,48}((?:\d[\s]*){3,7}\d)/i,
    /^[\s]*((?:\d[\s]*){3,7}\d)\s+is\s+your\b/im,
    /\b((?:\d[\s]*){3,7}\d)\s+is\s+your\s+(?:verification\s+)?code\b/i,
  ];
  for (const re of nearKeyword) {
    const hit = asCode(text.match(re)?.[1]);
    if (hit) return hit;
  }

  // HTML писем: цифры в соседних ячейках → «4 8 2 9 1 3».
  const spaced = asCode(text.match(/(?<!\d)((?:\d[ \t]+){3,7}\d)(?!\d)/)?.[1]);
  if (spaced) return spaced;

  return asCode(text.match(/(?<![\d-])(\d{4,8})(?![\d-])/)?.[1]);
}
