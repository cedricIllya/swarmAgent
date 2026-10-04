import type { AgentStatus } from "@swarm/contracts";

const LABEL: Record<AgentStatus, { text: string; cls: string; pulse?: boolean }> = {
  creating: { text: "Создаётся", cls: "badge-accent", pulse: true },
  provisioning: { text: "Поднимаем машину", cls: "badge-accent", pulse: true },
  running: { text: "Работает", cls: "badge-ok" },
  stopped: { text: "Остановлен", cls: "" },
  failed: { text: "Ошибка", cls: "badge-danger" },
  deleting: { text: "Удаляется", cls: "badge-warn", pulse: true },
};

export function StatusBadge({ status }: { status: AgentStatus }) {
  const l = LABEL[status];
  return (
    <span className={`badge ${l.cls}`}>
      <span className={`badge-dot ${l.pulse ? "pulse" : ""}`} />
      {l.text}
    </span>
  );
}
