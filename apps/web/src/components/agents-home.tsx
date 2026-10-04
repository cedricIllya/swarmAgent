"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Agent } from "@swarm/contracts";
import { StatusBadge } from "./status-badge";
import { CreateAgentForm } from "./create-agent-form";

export function AgentsHome({ initialAgents, ownerLogin }: { initialAgents: Agent[]; ownerLogin: string }) {
  const [agents, setAgents] = useState(initialAgents);
  const [open, setOpen] = useState(initialAgents.length === 0);

  const hasPending = agents.some((a) => a.status === "creating" || a.status === "provisioning" || a.status === "deleting");

  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(async () => {
      const res = await fetch("/api/agents");
      if (res.ok) setAgents(((await res.json()) as { agents: Agent[] }).agents);
    }, 4000);
    return () => clearInterval(t);
  }, [hasPending]);

  return (
    <>
      <div className="card-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Агенты</h1>
          <p className="muted small" style={{ margin: "4px 0 0" }}>
            У каждого — свой адрес для приглашений и своя машина.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen((v) => !v)}>
          {open ? "Скрыть" : "Создать агента"}
        </button>
      </div>

      {open && (
        <div className="card" style={{ marginBottom: 20 }}>
          <CreateAgentForm
            ownerLogin={ownerLogin}
            onCreated={(a) => {
              setAgents((prev) => [a, ...prev]);
              setOpen(false);
            }}
          />
        </div>
      )}

      {agents.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <p className="muted" style={{ margin: 0 }}>
            Агентов пока нет. Создайте первого — он получит адрес вида <code>{ownerLogin}.имя@домен</code>.
          </p>
        </div>
      ) : (
        <div className="grid grid-2">
          {agents.map((a) => (
            <Link key={a.id} href={`/agents/${a.id}`} className="card" style={{ color: "inherit", textDecoration: "none" }}>
              <div className="card-head" style={{ marginBottom: 8 }}>
                <h2>{a.name}</h2>
                <StatusBadge status={a.status} />
              </div>
              <div className="mono muted" style={{ marginBottom: 6 }}>
                {a.email}
              </div>
              <div className="faint small">{a.model}</div>
              {a.statusMessage && <div className="small" style={{ marginTop: 8, color: a.status === "failed" ? "var(--danger)" : "var(--text-muted)" }}>{a.statusMessage}</div>}
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
