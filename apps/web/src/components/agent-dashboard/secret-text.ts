export type TextPart = { type: "text"; value: string } | { type: "code"; value: string };

interface Hit {
  start: number;
  end: number;
  value: string;
}

/** Фразы, которыми runtime записывает код из письма в журнал задачи. */
const CODE_PATTERNS = [
  /код подтверждения из письма:\s*(\S+)/gi,
  /извлечён код\s+(\S+)/gi,
  /\(код\s+([^)\s]+)\)/gi,
];

function cleanToken(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/g, "");
}

/** Выделяет коды подтверждения из текста шага, чтобы показать их отдельно от фразы. */
export function splitCodes(text: string): TextPart[] {
  const hits: Hit[] = [];
  for (const pattern of CODE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      const index = match.index;
      if (!raw || index === undefined) continue;
      const value = cleanToken(raw);
      if (value.length < 3 || /^https?:/i.test(value)) continue;
      const local = match[0].lastIndexOf(raw);
      const start = index + local;
      hits.push({ start, end: start + value.length, value });
    }
  }
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  const taken: Hit[] = [];
  for (const hit of hits) {
    if (taken.some((prev) => hit.start < prev.end && hit.end > prev.start)) continue;
    taken.push(hit);
  }

  const parts: TextPart[] = [];
  let cursor = 0;
  for (const hit of taken) {
    if (hit.start > cursor) parts.push({ type: "text", value: text.slice(cursor, hit.start) });
    parts.push({ type: "code", value: hit.value });
    cursor = hit.end;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", value: text }];
}
