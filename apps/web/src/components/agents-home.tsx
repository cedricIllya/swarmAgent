"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { Agent } from "@swarm/contracts";
import { t } from "@/i18n";
import { StatusBadge } from "./status-badge";
import { CreateAgentForm } from "./create-agent-form";
import { AgentFace } from "./agent-avatar";
import { personStatus } from "./agent-dashboard/present-steps";

export function AgentsHome({
  initialAgents,
  ownerLogin,
  usage,
}: {
  initialAgents: Agent[];
  ownerLogin: string;
  /** Серверный блок расходов по всем агентам; его нет, когда агентов ещё нет. */
  usage?: ReactNode;
}) {
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
      <div className="page-head">
        <div>
          <span className="kicker">{t("common.workspace")}</span>
          <h1>{t("home.title")}</h1>
          <p className="lead">{t("home.lead")}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setOpen((v) => !v)}>
          {open ? t("home.hide") : t("home.create")}
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
        <div className="card empty">
          <div className="empty-art" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <h2>{t("home.emptyTitle")}</h2>
          <p className="muted" style={{ margin: "6px 0 0" }}>
            {t("home.emptyBody")} <code>{t("home.emptyExample", { login: ownerLogin })}</code>.
          </p>
        </div>
      ) : (
        <>
          {usage}
          <div className="grid grid-2">
            {agents.map((a) => (
              <Link key={a.id} href={`/agents/${a.id}`} className="card card-link">
                <div className="card-head" style={{ marginBottom: 10 }}>
                  <div className="row" style={{ gap: 10, minWidth: 0 }}>
                    <AgentFace agent={a} />
                    <h2>{a.name}</h2>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <div className="mono muted agent-card-email" title={a.email}>
                  {a.email}
                </div>
                {a.statusMessage && (
                  <div className="small" style={{ marginTop: 8, color: a.status === "failed" ? "var(--danger)" : "var(--text-muted)" }}>
                    {personStatus(a.statusMessage, a.status)}
                  </div>
                )}
                <div className="card-foot">
                  <span className="faint small">{a.model}</span>
                  {a.googleConnected && <span className="badge badge-ok">Google</span>}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}
