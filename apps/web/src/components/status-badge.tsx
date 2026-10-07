import type { AgentStatus } from "@swarm/contracts";
import { t, type MessageKey } from "@/i18n";

const LABEL: Record<AgentStatus, { key: MessageKey; cls: string; pulse?: boolean }> = {
  creating: { key: "status.creating", cls: "badge-accent", pulse: true },
  provisioning: { key: "status.provisioning", cls: "badge-accent", pulse: true },
  running: { key: "status.running", cls: "badge-ok" },
  stopped: { key: "status.stopped", cls: "" },
  failed: { key: "status.failed", cls: "badge-danger" },
  deleting: { key: "status.deleting", cls: "badge-warn", pulse: true },
};

export function StatusBadge({ status }: { status: AgentStatus }) {
  const l = LABEL[status];
  return (
    <span className={`badge ${l.cls}`}>
      <span className={`badge-dot ${l.pulse ? "pulse" : ""}`} />
      {t(l.key)}
    </span>
  );
}
