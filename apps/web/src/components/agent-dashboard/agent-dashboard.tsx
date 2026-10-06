"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Agent } from "@swarm/contracts";
import { useConfirm } from "../confirm-dialog";
import { StatusBadge } from "../status-badge";
import { AgentEmail } from "./agent-email";
import { EmailCard } from "./email-card";
import { LogsCard } from "./logs-card";
import { TaskComposer } from "./task-composer";
import { UsageCard } from "./usage-card";
import { AgentModelControl } from "./agent-model-control";
import { AgentAvatarControl } from "../agent-avatar";
import { useAgentLive } from "./use-agent-live";

export function AgentDashboard({ initialAgent }: { initialAgent: Agent }) {
  const { detail, stepsByRun, messagesByRun, livePending, patchAgent } = useAgentLive(initialAgent);
  const router = useRouter();
  const confirm = useConfirm();
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { agent, state, runtimeError, asleep, waking } = detail;

  async function remove() {
    if (removing) return;
    const ok = await confirm({
      title: `Удалить агента ${agent.name}?`,
      body: "Машина и диск будут уничтожены, адрес освободится.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setRemoving(true);
    setRemoveError(null);
    const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/");
      return;
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setRemoving(false);
    setRemoveError(body?.error ?? "Не получилось удалить агента");
  }

  return (
    <>
      <div className="page-head">
        <div className="agent-head">
          <AgentAvatarControl agent={agent} onUpdated={patchAgent} />
          <div>
            <Link href="/" className="kicker">
              ← Все агенты
            </Link>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <h1>{agent.name}</h1>
              <StatusBadge status={agent.status} />
              {asleep && <span className="badge">спит</span>}
              {waking && <span className="badge">просыпается</span>}
              {state?.busyInBrowser && <span className="badge badge-warn"><span className="badge-dot pulse" />в браузере</span>}
            </div>
            <AgentEmail email={agent.email} />
            {agent.statusMessage && (
              <div className="faint small" style={{ marginTop: 4 }}>
                {agent.statusMessage}
              </div>
            )}
            <AgentModelControl agent={agent} onUpdated={patchAgent} />
          </div>
        </div>
        <button className="btn btn-sm btn-danger" type="button" onClick={remove} disabled={removing}>
          {removing ? "Удаляем…" : "Удалить"}
        </button>
      </div>

      {removeError && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          {removeError}
        </div>
      )}

      {asleep && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Агент спит: процессор и память Fly не тарифицирует. Диск считается и во сне. Письмо, задача и одобрение будят машину.
        </div>
      )}

      {runtimeError && !asleep && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          Машина агента не отвечает: {runtimeError}
        </div>
      )}

      <EmailCard agent={agent} />
      <TaskComposer agent={agent} />
      <LogsCard
        agent={agent}
        state={state}
        stepsByRun={stepsByRun}
        messagesByRun={messagesByRun}
        pending={livePending}
      />
      <UsageCard state={state} pending={livePending} />
    </>
  );
}
