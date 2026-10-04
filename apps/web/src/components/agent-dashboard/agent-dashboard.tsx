"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Agent } from "@swarm/contracts";
import { StatusBadge } from "../status-badge";
import { ChatCard } from "./chat-card";
import { EmailCard } from "./email-card";
import { LogsCard } from "./logs-card";
import { ServicesCard } from "./services-card";
import { UsageCard } from "./usage-card";
import { useAgentLive } from "./use-agent-live";

export function AgentDashboard({ initialAgent }: { initialAgent: Agent }) {
  const { detail, stepsByRun, actionsBySession, onChatMessage } = useAgentLive(initialAgent);
  const router = useRouter();
  const { agent, state, runtimeError, asleep, waking } = detail;

  async function remove() {
    if (!confirm(`Удалить агента ${agent.name}? Машина и диск будут уничтожены, адрес освободится.`)) return;
    const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
  }

  return (
    <>
      <div className="page-head">
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
          <div className="faint small" style={{ marginTop: 4 }}>
            {agent.model}
            {agent.statusMessage ? ` · ${agent.statusMessage}` : ""}
          </div>
        </div>
        <button className="btn btn-sm btn-danger" onClick={remove}>
          Удалить
        </button>
      </div>

      {asleep && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Агент спит: процессор и память Fly не тарифицирует. Диск считается и во сне. Письмо, чат и одобрение будят машину.
        </div>
      )}

      {runtimeError && !asleep && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          Машина агента не отвечает: {runtimeError}
        </div>
      )}

      <EmailCard agent={agent} />
      <ChatCard
        agent={agent}
        state={state}
        onChatMessage={onChatMessage}
        actionsBySession={actionsBySession}
        stepsByRun={stepsByRun}
      />
      <ServicesCard agent={agent} state={state} />
      <LogsCard agent={agent} state={state} stepsByRun={stepsByRun} />
      <UsageCard state={state} />
    </>
  );
}
