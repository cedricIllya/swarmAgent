import Link from "next/link";
import type { Agent } from "@swarm/contracts";
import type { TenantConnection } from "@swarm/connections";
import { t } from "@/i18n";
import { accessKindLabel } from "./agent-dashboard/agent-access";
import { TaskWatchTag } from "./task-watch-tag";
import { AgentFace } from "./agent-avatar";
import { DisconnectGoogleButton, DisconnectServiceButton, ServiceAgentChips } from "./disconnect-service";

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

export function ServicesOverview({ agents, connections }: { agents: Agent[]; connections: TenantConnection[] }) {
  const slack = connections.find((connection) => connection.slug === "slack");
  const catalog = connections.filter((connection) => connection.slug !== "slack");
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
          <span className="kicker">{t("common.workspace")}</span>
          <h1>{t("services.title")}</h1>
          <p className="lead">{t("services.lead")}</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat-card">
          <span className="stat-value">{serviceCount}</span>
          <span className="stat-label">{t("services.statServices")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{totalLinks}</span>
          <span className="stat-label">{t("services.statConnections")}</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">
            {agentsWithAccess.size}
            <span className="stat-of"> / {agents.length}</span>
          </span>
          <span className="stat-label">{t("services.statAgents")}</span>
        </div>
      </div>

      <GoogleCard agents={agents} />
      <SlackCard agents={agents} connection={slack} />

      {catalog.length === 0 ? (
        connections.length === 0 ? (
          <EmptyState agents={agents} />
        ) : null
      ) : (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>{t("services.catalogTitle")}</h2>
              <span className="muted small">{t("services.catalogLead")}</span>
            </div>
            <span className="badge">{catalog.length}</span>
          </div>
          <div className="service-list">
            {catalog.map((c) => (
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
            <span className="muted small">{t("services.googleLead")}</span>
          </div>
        </div>
        <span className={`badge ${connected.length ? "badge-ok" : ""}`}>
          {connected.length ? t("common.countOf", { count: connected.length, total: agents.length }) : t("common.notConnected")}
        </span>
      </div>

      {agents.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          {t("services.googleEmptyBefore")} <Link href="/">{t("services.googleEmptyLink")}</Link> {t("services.googleEmptyAfter")}
        </p>
      ) : (
        <div className="agent-links">
          {connected.map((a) => (
            <div key={a.id} className="agent-link">
              <Link href={`/agents/${a.id}`} className="agent-link-name">
                <AgentFace agent={a} size="sm" />
                {a.name}
              </Link>
              <span className="agent-link-meta mono">{a.googleEmail ?? t("common.googleAccount")}</span>
              <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <a className="btn btn-sm btn-ghost" href={`/api/agents/${a.id}/google`}>
                  {t("common.reconnect")}
                </a>
                <DisconnectGoogleButton agentId={a.id} agentName={a.name} />
              </div>
            </div>
          ))}
          {rest.map((a) => (
            <div key={a.id} className="agent-link agent-link-off">
              <Link href={`/agents/${a.id}`} className="agent-link-name">
                <AgentFace agent={a} size="sm" />
                {a.name}
              </Link>
              <span className="agent-link-meta">{t("common.notConnected")}</span>
              <a className="btn btn-sm" href={`/api/agents/${a.id}/google`}>
                {t("common.connect")}
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SlackCard({ agents, connection }: { agents: Agent[]; connection: TenantConnection | undefined }) {
  const linked = new Set(connection?.agents.map((agent) => agent.agentId) ?? []);
  const connected = agents.filter((agent) => linked.has(agent.id));
  const rest = agents.filter((agent) => !linked.has(agent.id));
  return (
    <section className="card">
      <div className="card-head">
        <div className="row" style={{ gap: 12 }}>
          <span className="avatar avatar-slack" aria-hidden>
            S
          </span>
          <div>
            <h2>Slack</h2>
            <span className="muted small">{t("services.slackLead")}</span>
          </div>
        </div>
        <span className={`badge ${connected.length ? "badge-ok" : ""}`}>
          {connected.length ? t("common.countOf", { count: connected.length, total: agents.length }) : t("common.notConnected")}
        </span>
      </div>

      {agents.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          {t("services.googleEmptyBefore")} <Link href="/">{t("services.googleEmptyLink")}</Link> {t("services.slackEmptyAfter")}
        </p>
      ) : (
        <div className="agent-links">
          {connected.map((agent) => (
            <div key={agent.id} className="agent-link">
              <Link href={`/agents/${agent.id}`} className="agent-link-name">
                <AgentFace agent={agent} size="sm" />
                {agent.name}
              </Link>
              <span className="agent-link-meta">{t("common.connected")}</span>
              <div className="row" style={{ gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <a className="btn btn-sm btn-ghost" href={`/api/agents/${agent.id}/slack`}>
                  {t("common.reconnect")}
                </a>
                <DisconnectServiceButton agentId={agent.id} slug="slack" serviceName="Slack" agentName={agent.name} />
              </div>
            </div>
          ))}
          {rest.map((agent) => (
            <div key={agent.id} className="agent-link agent-link-off">
              <Link href={`/agents/${agent.id}`} className="agent-link-name">
                <AgentFace agent={agent} size="sm" />
                {agent.name}
              </Link>
              <span className="agent-link-meta">{t("common.notConnected")}</span>
              <a className="btn btn-sm" href={`/api/agents/${agent.id}/slack`}>
                {t("common.connect")}
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
      <h2>{t("services.emptyTitle")}</h2>
      <p className="muted" style={{ maxWidth: 520, margin: "6px auto 18px" }}>
        {t("services.emptyLead")}
      </p>
      <div className="how-grid">
        <div className="how">
          <span className="how-num">1</span>
          <div>
            <strong>{t("services.inviteTitle")}</strong>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              {t("services.inviteBefore")}
              {first ? (
                <>
                  {" "}
                  {t("services.inviteExample")} <code>{first.email}</code>
                </>
              ) : (
                ""
              )}
              {t("services.inviteAfter")}
            </p>
          </div>
        </div>
        <div className="how">
          <span className="how-num">2</span>
          <div>
            <strong>{t("services.keyTitle")}</strong>
            <p className="muted small" style={{ margin: "2px 0 0" }}>
              {t("services.keyBody")}
            </p>
          </div>
        </div>
      </div>
      {first && (
        <Link href={`/agents/${first.id}`} className="btn btn-primary" style={{ marginTop: 20 }}>
          {t("services.openAgent", { name: first.name })}
        </Link>
      )}
    </section>
  );
}
