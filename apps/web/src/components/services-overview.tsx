import Link from "next/link";
import type { Agent } from "@swarm/contracts";
import type { TenantConnection } from "@swarm/connections";
import { accessKindLabel } from "./agent-dashboard/agent-access";
import { TaskWatchTag } from "./task-watch-tag";
import { AgentFace } from "./agent-avatar";
import { ServiceAgentChips } from "./disconnect-service";

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

export function ServicesOverview({ agents, connections }: { agents: Agent[]; connections: TenantConnection[] }) {
  const googleAgents = agents.filter((a) => a.googleConnected);
  const totalLinks = connections.reduce((n, c) => n + c.agents.length, 0) + googleAgents.length;
  const agentsWithAccess = new Set<string>([
    ...googleAgents.map((a) => a.id),
    ...connections.flatMap((c) => c.agents.map((a) => a.agentId)),
  ]);
  const serviceCount = connections.length + (googleAgents.length ? 1 : 0);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="kicker">Рабочее пространство</span>
          <h1>Подключённые сервисы</h1>
          <p className="lead">Куда у ваших агентов уже есть доступ.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat-card">
          <span className="stat-value">{serviceCount}</span>
          <span className="stat-label">сервисов</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{totalLinks}</span>
          <span className="stat-label">подключений</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">
            {agentsWithAccess.size}
            <span className="stat-of"> / {agents.length}</span>
          </span>
          <span className="stat-label">агентов с доступом</span>
        </div>
      </div>

      <GoogleCard agents={agents} />

      {connections.length === 0 ? (
        <EmptyState agents={agents} />
      ) : (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Из каталога</h2>
              <span className="muted small">Сервисы, в которые агенты вошли сами — по приглашению или ключу</span>
            </div>
            <span className="badge">{connections.length}</span>
          </div>
          <div className="service-list">
            {connections.map((c) => (
              <ServiceRow key={c.slug} connection={c} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function GoogleCard({ agents }: { agents: Agent[] }) {
  const connected = agents.filter((a) => a.googleConnected);
  const rest = agents.filter((a) => !a.googleConnected);
  return (
    <section className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 12 }}>
          <span className="avatar avatar-google" aria-hidden>
            G
          </span>
          <div>
            <h2>Google Workspace</h2>
            <span className="muted small">Почта, календарь и документы — подключается отдельно для каждого агента</span>
          </div>
        </div>
        <span className={`badge ${connected.length ? "badge-ok" : ""}`}>
          {connected.length ? `${connected.length} из ${agents.length}` : "не подключён"}
        </span>
      </div>

      {agents.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          Сначала <Link href="/">создайте агента</Link> — Google подключается к конкретному агенту.
        </p>
      ) : (
        <div className="agent-links">
          {connected.map((a) => (
            <div key={a.id} className="agent-link">
              <Link href={`/agents/${a.id}`} className="agent-link-name">
                <AgentFace agent={a} size="sm" />
                {a.name}
              </Link>
              <span className="agent-link-meta mono">{a.googleEmail ?? "аккаунт Google"}</span>
              <a className="btn btn-sm btn-ghost" href={`/api/agents/${a.id}/google`}>
                Переподключить
              </a>
            </div>
          ))}
          {rest.map((a) => (
            <div key={a.id} className="agent-link agent-link-off">
              <Link href={`/agents/${a.id}`} className="agent-link-name">
                <AgentFace agent={a} size="sm" />
                {a.name}
              </Link>
              <span className="agent-link-meta">не подключён</span>
              <a className="btn btn-sm" href={`/api/agents/${a.id}/google`}>
                Подключить
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ServiceRow({ connection }: { connection: TenantConnection }) {
  return (
    <div className="service-row">
      <span className="avatar" aria-hidden>
        {initials(connection.name)}
      </span>
      <div className="service-main">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <strong>{connection.name}</strong>
          <span className="badge">{accessKindLabel(connection.kind)}</span>
          <TaskWatchTag watchesTasks={connection.watchesTasks} channel={connection.channel} />
        </div>
        {connection.domains.length > 0 && <div className="faint small">{connection.domains.join(", ")}</div>}
      </div>
      <ServiceAgentChips slug={connection.slug} serviceName={connection.name} agents={connection.agents} />
    </div>
  );
}

function EmptyState({ agents }: { agents: Agent[] }) {
  const first = agents[0];
  return (
    <section className="card empty">
      <div className="empty-art" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <h2>Пока агенты никуда не вошли</h2>
      <p className="muted" style={{ maxWidth: 520, margin: "6px auto 18px" }}>
        Сервисы появляются здесь сами, как только агент получит доступ. Для этого есть два пути:
      </p>
      <div className="how-grid">
        <div className="how">
          <span className="how-num">1</span>
          <div>
            <strong>Приглашение на почту</strong>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              Пригласите агента в сервис на его адрес
              {first ? (
                <>
                  {" "}
                  — например, <code>{first.email}</code>
                </>
              ) : (
                ""
              )}
              . Он примет инвайт и сохранит вход.
            </p>
          </div>
        </div>
        <div className="how">
          <span className="how-num">2</span>
          <div>
            <strong>Ссылка и ключ в задаче</strong>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              Вставьте агенту ссылку на сервис и API-ключ или токен. Он разберётся, как войти.
            </p>
          </div>
        </div>
      </div>
      {first && (
        <Link href={`/agents/${first.id}`} className="btn btn-primary" style={{ marginTop: 20 }}>
          Открыть агента {first.name}
        </Link>
      )}
    </section>
  );
}
