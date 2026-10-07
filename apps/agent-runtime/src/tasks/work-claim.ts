import type { Run, RunStep } from "@swarm/contracts";
import type { AgentRuntime } from "../runtime";
import { exactMark, normalizeService, serviceFromTitle, titleMark, workMarks } from "./work-marks";

/**
 * Задача, которую уже взяли письмо или плановая проверка.
 * Вторая дверь с той же меткой не открывает новый прогон, пока первый не закрыт.
 * Плановая проверка сама работой не считается.
 */
const SURVEY_TITLE = "Плановая проверка сервисов";
const OPEN = new Set<Run["status"]>(["queued", "running", "waiting_approval", "escalated"]);

interface Held {
  id: string;
  runId: string | null;
  title: string;
  service: string | null;
  marks: string[];
  broad: boolean;
}

export interface WorkIdentity {
  service: string | null;
  title: string;
  texts: string[];
  /** Письмо-сигнал без конкретной карточки: пока оно идёт, сервис второй раз не открываем. */
  broad: boolean;
}

export type WorkHold =
  | { ok: true; id: string; marks: string[]; broad: boolean }
  | { ok: false; runId: string | null; title: string };

const buckets = new WeakMap<AgentRuntime, Map<string, Held>>();
const locks = new WeakMap<AgentRuntime, Promise<unknown>>();
let holdSeq = 0;

function bucket(rt: AgentRuntime): Map<string, Held> {
  let map = buckets.get(rt);
  if (!map) {
    map = new Map();
    buckets.set(rt, map);
  }
  return map;
}

function exclusive<T>(rt: AgentRuntime, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(rt) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    rt,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function marksOf(identity: WorkIdentity): { marks: string[]; broad: boolean; service: string | null } {
  const service = normalizeService(identity.service);
  const marks = workMarks([identity.title, ...identity.texts]);
  const title = titleMark(identity.title, service);
  if (title) marks.push(title);
  marks.push(exactMark(identity.title));
  const specific = marks.some((mark) => mark.startsWith("ticket:") || mark.startsWith("url:"));
  return { marks, broad: identity.broad && !specific, service };
}

function overlaps(held: Held, incoming: { service: string | null; marks: string[]; broad: boolean }): boolean {
  const heldTickets = held.marks.filter((mark) => mark.startsWith("ticket:"));
  const nextTickets = incoming.marks.filter((mark) => mark.startsWith("ticket:"));
  if (heldTickets.some((mark) => nextTickets.includes(mark))) return true;
  const distinctTickets = heldTickets.length > 0 && nextTickets.length > 0;

  if (held.marks.some((mark) => mark.startsWith("url:") && incoming.marks.includes(mark))) return true;
  if (!distinctTickets && held.marks.some((mark) => (mark.startsWith("title:") || mark.startsWith("exact:")) && incoming.marks.includes(mark))) {
    return true;
  }
  if (!distinctTickets && titleWordsOverlap(held.marks, incoming.marks)) return true;
  if ((held.broad || incoming.broad) && held.service !== null && held.service === incoming.service) return true;
  return false;
}

/** Одинаковое название при разных префиксах сервиса. Разные сервисы не склеиваются. */
function titleWordsOverlap(left: string[], right: string[]): boolean {
  const a = left.filter((mark) => mark.startsWith("title:"));
  const b = right.filter((mark) => mark.startsWith("title:"));
  for (const x of a) {
    for (const y of b) {
      const px = splitTitle(x);
      const py = splitTitle(y);
      if (px.words !== py.words) continue;
      if (px.service && py.service && px.service !== py.service) continue;
      return true;
    }
  }
  return false;
}

function splitTitle(mark: string): { service: string | null; words: string } {
  const rest = mark.slice("title:".length);
  const split = rest.indexOf(":");
  if (split < 0) return { service: null, words: rest };
  return { service: rest.slice(0, split), words: rest.slice(split + 1) };
}

function storedMarks(step: RunStep): string[] {
  const raw = step.data?.workMarks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function storedService(steps: RunStep[], title: string): string | null {
  for (const step of steps) {
    const value = step.data?.workService ?? step.data?.service;
    if (typeof value === "string") {
      const slug = normalizeService(value);
      if (slug) return slug;
    }
  }
  return serviceFromTitle(title);
}

async function refresh(rt: AgentRuntime, map: Map<string, Held>): Promise<void> {
  const known = new Set([...map.values()].map((held) => held.runId).filter((id): id is string => id !== null));
  const runs = await rt.store.listRuns(200);
  for (const run of runs) {
    if (!OPEN.has(run.status) || run.title === SURVEY_TITLE || known.has(run.id)) continue;
    const steps = await rt.store.listSteps(run.id);
    const texts = [run.title, ...steps.map((step) => step.text)];
    const service = storedService(steps, run.title);
    const marks = [...new Set([...steps.flatMap(storedMarks), ...workMarks(texts)])];
    const title = titleMark(run.title, service);
    if (title && !marks.includes(title)) marks.push(title);
    const exact = exactMark(run.title);
    if (!marks.includes(exact)) marks.push(exact);
    const broad = steps.some((step) => step.data?.broad === true) && !marks.some((mark) => mark.startsWith("ticket:") || mark.startsWith("url:"));
    map.set(run.id, { id: run.id, runId: run.id, title: run.title, service, marks, broad });
  }

  for (const [id, held] of map) {
    if (!held.runId) continue;
    const run = await rt.store.getRun(held.runId);
    if (!run || !OPEN.has(run.status) || run.title !== held.title) map.delete(id);
  }
}

/** Занять метки до создания прогона. `ok: false` — эта работа уже идёт. */
export function holdWork(rt: AgentRuntime, identity: WorkIdentity): Promise<WorkHold> {
  return exclusive(rt, async () => {
    const map = bucket(rt);
    await refresh(rt, map);
    const incoming = marksOf(identity);
    for (const held of map.values()) {
      if (!overlaps(held, incoming)) continue;
      return { ok: false, runId: held.runId, title: held.title };
    }
    const id = `hold_${++holdSeq}`;
    map.set(id, {
      id,
      runId: null,
      title: identity.title,
      service: incoming.service,
      marks: incoming.marks,
      broad: incoming.broad,
    });
    return { ok: true, id, marks: incoming.marks, broad: incoming.broad };
  });
}

/** Прогон создан: метка теперь указывает на него и переживёт следующий заход. */
export function bindWork(rt: AgentRuntime, holdId: string, runId: string, title: string): void {
  const map = bucket(rt);
  const held = map.get(holdId);
  if (!held) return;
  map.delete(holdId);
  held.id = runId;
  held.runId = runId;
  held.title = title;
  map.set(runId, held);
}

/** Прогон не создался — метку отпускаем, иначе она закроет задачу навсегда. */
export function dropWork(rt: AgentRuntime, holdId: string): void {
  bucket(rt).delete(holdId);
}
