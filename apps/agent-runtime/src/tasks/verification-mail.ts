import type { Run } from "@swarm/contracts";

/** Сколько после конца задачи письмо с кодом ещё пишется в её журнал, а не в новую задачу. */
const ATTACH_MS = 30 * 60 * 1000;

const applied = new Set<string>();

/** Код этого письма уже отдан в задачу входа. Повторный разбор задачу не открывает. */
export function markVerificationApplied(messageId: string | null | undefined): void {
  if (messageId) applied.add(messageId);
}

export function verificationAlreadyApplied(messageId: string | null | undefined): boolean {
  return Boolean(messageId && applied.has(messageId));
}

/**
 * Куда дописать код. `runs` — от новых к старым.
 * Своя задача входа важнее любой другой, плановая проверка коды не принимает.
 */
export function verificationRunId(
  runs: Array<Pick<Run, "id" | "status" | "trigger" | "startedAt" | "finishedAt">>,
  now: number,
  preferred: string | null,
): string | null {
  if (preferred) return preferred;
  const candidates = runs.filter((run) => run.trigger !== "cron");
  const open = candidates.find(
    (run) => run.status === "running" || run.status === "queued" || run.status === "waiting_approval",
  );
  if (open) return open.id;
  const recent = candidates.find((run) => {
    const at = Date.parse(run.finishedAt ?? run.startedAt);
    return Number.isFinite(at) && now - at >= 0 && now - at <= ATTACH_MS;
  });
  return recent?.id ?? null;
}
