"use client";

import { useState } from "react";
import type { Agent } from "@swarm/contracts";
import { t } from "@/i18n";
import { DisconnectGoogleButton, DisconnectServiceButton } from "../disconnect-service";
import { TaskWatchTag } from "../task-watch-tag";
import { accessKindLabel, type AgentAccess } from "./agent-access";
import { ListSkeleton } from "../skeleton";

export function EmailCard({
  agent,
  services,
  pending,
  onRemoved,
}: {
  agent: Agent;
  services: AgentAccess[];
  pending: boolean;
  onRemoved: (slug: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t("services.cardTitle")}</h2>
        <span className="muted small">{t("services.cardLead")}</span>
      </div>
      {error && (
        <p className="notice notice-warn" style={{ margin: "0 0 14px" }}>
          {error}
        </p>
      )}
      {pending ? (
        <ListSkeleton count={1} />
      ) : services.length === 0 ? (
        <p className="faint small" style={{ margin: "0 0 14px" }}>
          {t("services.noneYet")}
        </p>
      ) : (
        <div className="list" style={{ marginBottom: 14 }}>
          {services.map((service) => (
            <div key={service.slug} className="list-item">
              <div className="row" style={{ justifyContent: "space-between", gap: 8, width: "100%" }}>
                <div>
                  <div>{service.name}</div>
                  {(service.accountName || service.accountEmail) && (
                    <div className="faint small" style={{ marginTop: 2 }}>
                      {[service.accountName, service.accountEmail].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 8, flex: "none" }}>
                  <span className="badge">{accessKindLabel(service.kind)}</span>
                  <TaskWatchTag watchesTasks={service.watchesTasks} channel={service.channel} />
                  <DisconnectServiceButton
                    agentId={agent.id}
                    slug={service.slug}
                    serviceName={service.name}
                    onRemoved={() => onRemoved(service.slug)}
                    onFailed={setError}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted small row" style={{ gap: 8 }}>
          Google:
          {agent.googleConnected ? (
            <span className="badge badge-ok">{agent.googleEmail ?? t("common.connected")}</span>
          ) : (
            <span className="badge">{t("common.notConnected")}</span>
          )}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn btn-sm" href={`/api/agents/${agent.id}/google`}>
            {agent.googleConnected ? t("services.reconnectGoogle") : t("services.connectGoogle")}
          </a>
          {agent.googleConnected && <DisconnectGoogleButton agentId={agent.id} onFailed={setError} />}
        </div>
      </div>
    </section>
  );
}
