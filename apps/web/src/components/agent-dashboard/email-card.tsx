"use client";

import type { Agent } from "@swarm/contracts";
import { accessKindLabel, type AgentAccess } from "./agent-access";
import { ListSkeleton } from "../skeleton";

export function EmailCard({
  agent,
  services,
  pending,
}: {
  agent: Agent;
  services: AgentAccess[];
  pending: boolean;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключение сервисов</h2>
        <span className="muted small">Пришлите инвайт на адрес агента или вставьте ссылку и ключ в задачу</span>
      </div>
      {pending ? (
        <ListSkeleton count={1} />
      ) : services.length === 0 ? (
        <p className="faint small" style={{ margin: "0 0 14px" }}>
          Пока ни одного сервиса.
        </p>
      ) : (
        <div className="list" style={{ marginBottom: 14 }}>
          {services.map((service) => (
            <div key={service.slug} className="list-item">
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div>{service.name}</div>
                  {(service.accountName || service.accountEmail) && (
                    <div className="faint small" style={{ marginTop: 2 }}>
                      {[service.accountName, service.accountEmail].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <span className="badge">{accessKindLabel(service.kind)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted small row" style={{ gap: 8 }}>
          Google:
          {agent.googleConnected ? (
            <span className="badge badge-ok">{agent.googleEmail ?? "подключён"}</span>
          ) : (
            <span className="badge">не подключён</span>
          )}
        </span>
        <a className="btn btn-sm" href={`/api/agents/${agent.id}/google`}>
          {agent.googleConnected ? "Переподключить Google" : "Подключить Google"}
        </a>
      </div>
    </section>
  );
}
