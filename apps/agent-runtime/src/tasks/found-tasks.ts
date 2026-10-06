/** Задача, которую плановая проверка нашла и не стала делать сама. */
export interface FoundTask {
  service: string;
  title: string;
  detail: string;
}

const MAX_TASKS = 8;

function textOf(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Заголовок отдельной задачи: сервис и название, без повтора, если оно уже внутри. */
export function taskRunTitle(task: FoundTask): string {
  const title = task.title.replace(/\s+/g, " ").trim();
  const service = task.service.trim();
  const combined = service && !title.toLowerCase().includes(service.toLowerCase()) ? `${service}: ${title}` : title;
  return combined.slice(0, 120);
}

/**
 * JSON из ответа проверки. Проза и «пусто» — пустой список.
 * Берётся первый объект с полем tasks, в том числе из ```json.
 */
export function parseFoundTasks(text: string): FoundTask[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(source.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { tasks?: unknown }).tasks)) return [];
  const out: FoundTask[] = [];
  for (const item of (raw as { tasks: unknown[] }).tasks) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const service = textOf(rec.service, 80);
    const title = textOf(rec.title, 120);
    if (!service || !title) continue;
    const detail = textOf(rec.detail, 2000) || title;
    out.push({ service, title, detail });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

/** Уже идущие или ждущие задачи с тем же заголовком второй раз не ставятся. */
export function selectNewTasks(
  found: FoundTask[],
  openTitles: string[],
): { fresh: FoundTask[]; already: string[] } {
  const open = new Set(openTitles.map((title) => title.replace(/\s+/g, " ").trim().toLowerCase()));
  const seen = new Set<string>();
  const fresh: FoundTask[] = [];
  const already: string[] = [];
  for (const task of found) {
    const title = taskRunTitle(task);
    const key = title.toLowerCase();
    if (open.has(key) || seen.has(key)) {
      if (!already.some((item) => item.toLowerCase() === key)) already.push(title);
      continue;
    }
    seen.add(key);
    fresh.push(task);
  }
  return { fresh, already };
}

/** Итог проверки для журнала: список очереди, а не сырой JSON модели. */
export function surveySummary(reply: string, queuedTitles: string[], alreadyTitles: string[]): string {
  if (queuedTitles.length) return `В работе: ${queuedTitles.join("; ")}`.slice(0, 2000);
  if (alreadyTitles.length) return `Уже в работе: ${alreadyTitles.join("; ")}`.slice(0, 2000);
  if (/"tasks"\s*:\s*\[\s*\]/.test(reply)) return "пусто";
  return reply;
}
