import type { Run } from "@swarm/contracts";

/** Живой прогон заменяет одноимённую заготовку, которую показали до ответа сервера. */
export function mergeLiveRun(runs: Run[], incoming: Run, pendingIds: ReadonlySet<string>): { runs: Run[]; droppedId: string | null } {
  const placeholder =
    incoming.trigger === "chat"
      ? [...runs].reverse().find((r) => pendingIds.has(r.id) && r.title === incoming.title)
      : undefined;
  const next = [incoming, ...runs.filter((r) => r.id !== incoming.id && r.id !== placeholder?.id)];
  next.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { runs: next, droppedId: placeholder?.id ?? null };
}

/** Ответ сервера подменяет заготовку настоящим id, если событие ещё не пришло. */
export function adoptStagedRun(runs: Run[], localId: string, runId: string): Run[] {
  if (runs.some((r) => r.id === runId)) return runs.filter((r) => r.id !== localId);
  return runs.map((r) => (r.id === localId ? { ...r, id: runId } : r));
}
