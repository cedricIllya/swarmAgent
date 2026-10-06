"use client";

import type { Agent } from "@swarm/contracts";

export function EmailCard({ agent }: { agent: Agent }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключение сервисов</h2>
        <span className="muted small">Пришлите инвайт на адрес агента или вставьте ссылку и ключ в задачу</span>
      </div>
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
