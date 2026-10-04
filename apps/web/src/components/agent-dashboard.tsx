"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, BrowserSession, Run, RunStep, RuntimeState, UsageByTask } from "@swarm/contracts";
import { StatusBadge } from "./status-badge";

interface Detail {
  agent: Agent;
  state: RuntimeState | null;
  runtimeError: string | null;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function AgentDashboard({ initialAgent }: { initialAgent: Agent }) {
  const [detail, setDetail] = useState<Detail>({ agent: initialAgent, state: null, runtimeError: null });
  const router = useRouter();

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/agents/${initialAgent.id}`, { cache: "no-store" });
    if (res.ok) setDetail((await res.json()) as Detail);
  }, [initialAgent.id]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const { agent, state, runtimeError } = detail;

  async function remove() {
    if (!confirm(`Удалить агента ${agent.name}? Машина и диск будут уничтожены, адрес освободится.`)) return;
    const res = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (res.ok) router.push("/");
  }

  return (
    <>
      <div className="card-head" style={{ marginBottom: 18 }}>
        <div>
          <div className="row" style={{ gap: 10 }}>
            <h1>{agent.name}</h1>
            <StatusBadge status={agent.status} />
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

      {runtimeError && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          Машина агента не отвечает: {runtimeError}
        </div>
      )}

      <EmailCard agent={agent} />
      <ChatCard agent={agent} state={state} onChanged={refresh} />
      <ServicesCard agent={agent} state={state} />
      <LogsCard agent={agent} state={state} />
      <UsageCard state={state} />
    </>
  );
}

function EmailCard({ agent }: { agent: Agent }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Почта для приглашений</h2>
        <span className="muted small">Пришлите сюда инвайт — агент сам войдёт и онбордится</span>
      </div>
      <div className="email-box">
        <code>{agent.email}</code>
        <button
          className="btn btn-sm"
          onClick={async () => {
            await navigator.clipboard.writeText(agent.email);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <span className="muted small">
          Google: {agent.googleConnected ? <span style={{ color: "var(--ok)" }}>подключён</span> : "не подключён"}
        </span>
        <a className="btn btn-sm" href={`/api/agents/${agent.id}/google`}>
          {agent.googleConnected ? "Переподключить Google" : "Подключить Google"}
        </a>
      </div>
    </section>
  );
}

function ChatCard({ agent, state, onChanged }: { agent: Agent; state: RuntimeState | null; onChanged: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [autonomous, setAutonomous] = useState(agent.autonomous);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => setAutonomous(agent.autonomous), [agent.autonomous]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [state?.chat.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    await fetch(`/api/agents/${agent.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    setText("");
    setBusy(false);
    await onChanged();
  }

  async function toggle(v: boolean) {
    setAutonomous(v);
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomous: v }),
    });
    await onChanged();
  }

  async function decide(id: string, approved: boolean) {
    await fetch(`/api/agents/${agent.id}/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    await onChanged();
  }

  const running = agent.status === "running";

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Чат</h2>
          <span className="muted small">Задание напрямую, в обход подключённых сервисов</span>
        </div>
        <label className="switch" title="Агент не будет спрашивать одобрение перед изменениями">
          <input type="checkbox" checked={autonomous} onChange={(e) => toggle(e.target.checked)} />
          <span className="switch-track" />
          <span className="small">Разрешать все действия без человека</span>
        </label>
      </div>

      {state?.pendingApprovals.length ? (
        <div className="list" style={{ marginBottom: 12 }}>
          {state.pendingApprovals.map((p) => (
            <div key={p.id} className="list-item" style={{ borderColor: "rgba(245,184,79,0.4)" }}>
              <div>
                <div className="small" style={{ color: "var(--warn)" }}>Нужно одобрение</div>
                <div>{p.description}</div>
              </div>
              <div className="row">
                <button className="btn btn-sm btn-primary" onClick={() => decide(p.id, true)}>Да</button>
                <button className="btn btn-sm" onClick={() => decide(p.id, false)}>Нет</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="chat">
        {!state?.chat.length && <p className="faint small" style={{ margin: 0 }}>Сообщений пока нет.</p>}
        {state?.chat.map((m, i) => (
          <div key={i} className={`bubble ${m.role === "user" ? "bubble-user" : "bubble-agent"}`}>
            {m.text}
            <span className="bubble-time">{fmtTime(m.at)}</span>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={running ? "Что сделать?" : "Агент ещё поднимается…"}
          disabled={!running}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={!running || busy || !text.trim()}>
          Отправить
        </button>
      </form>
    </section>
  );
}

function ServicesCard({ agent, state }: { agent: Agent; state: RuntimeState | null }) {
  const list = state?.connectedServices ?? [];
  const kindLabel = { mcp: "MCP", api: "API", browser: "браузер" } as const;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключённые сервисы</h2>
        <span className="muted small">Способ входа — общий на продукт, доступ — ваш</span>
      </div>
      {list.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          Пока ничего. Пришлите приглашение на <code>{agent.email}</code>.
        </p>
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.slug} className="list-item">
              <div>
                <div>{s.name}</div>
                <div className="faint small mono">{s.slug}</div>
              </div>
              <div className="row">
                <span className="badge">{kindLabel[s.kind]}</span>
                <span className={`badge ${s.hasCredential ? "badge-ok" : ""}`}>
                  {s.hasCredential ? "вход есть" : "нет доступа"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const STATUS_LABEL: Record<Run["status"], { text: string; cls: string }> = {
  queued: { text: "в очереди", cls: "" },
  running: { text: "идёт", cls: "badge-accent" },
  waiting_approval: { text: "ждёт одобрения", cls: "badge-warn" },
  done: { text: "готово", cls: "badge-ok" },
  failed: { text: "ошибка", cls: "badge-danger" },
};

const TRIGGER_LABEL: Record<Run["trigger"], string> = {
  email: "письмо",
  chat: "чат",
  cron: "по расписанию",
  approval: "одобрение",
};

function LogsCard({ agent, state }: { agent: Agent; state: RuntimeState | null }) {
  const runs = state?.runs ?? [];
  const sessionsByRun = new Map<string, BrowserSession[]>();
  for (const s of state?.browserSessions ?? []) {
    const arr = sessionsByRun.get(s.runId) ?? [];
    arr.push(s);
    sessionsByRun.set(s.runId, arr);
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>Логи работы</h2>
        <span className="muted small">{runs.length} задач</span>
      </div>
      {runs.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>Задач ещё не было.</p>
      ) : (
        <div className="list">
          {runs.map((r) => (
            <RunItem key={r.id} agent={agent} run={r} sessions={sessionsByRun.get(r.id) ?? []} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunItem({ agent, run, sessions }: { agent: Agent; run: Run; sessions: BrowserSession[] }) {
  const [steps, setSteps] = useState<RunStep[] | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    if (steps) return;
    const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}`);
    if (res.ok) setSteps(((await res.json()) as { steps: RunStep[] }).steps);
  }

  const st = STATUS_LABEL[run.status];
  return (
    <details
      className="list-item"
      style={{ display: "block" }}
      open={open}
      onToggle={(e) => {
        const o = (e.target as HTMLDetailsElement).open;
        setOpen(o);
        if (o) void load();
      }}
    >
      <summary className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <div>{run.title}</div>
          <div className="faint small">
            {fmtTime(run.startedAt)} · {TRIGGER_LABEL[run.trigger]}
            {sessions.length ? ` · браузер ×${sessions.length}` : ""}
          </div>
        </div>
        <span className={`badge ${st.cls}`}>{st.text}</span>
      </summary>
      {run.summary && <p className="small" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>{run.summary}</p>}
      <div className="steps">
        {steps === null && <span className="step">загрузка…</span>}
        {steps?.map((s, i) => (
          <div key={i} className="step">
            <b>{s.kind}</b> · {s.text}
          </div>
        ))}
      </div>
      {sessions.map((s) => (
        <div key={s.id} style={{ marginTop: 12 }}>
          <div className="small muted">
            {s.provider === "skyvern" ? "Skyvern" : "Browserbase"} · {s.purpose} · {fmtTime(s.startedAt)}
          </div>
          {s.hasVideo ? (
            <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${s.id}/video`} />
          ) : (
            <span className="faint small">{s.finishedAt ? "видео недоступно" : "сессия идёт, видео появится после"}</span>
          )}
        </div>
      ))}
    </details>
  );
}

function UsageCard({ state }: { state: RuntimeState | null }) {
  const u = state?.usage;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Токены и деньги</h2>
        <span className="muted small">По задачам и действиям, как вернул OpenRouter</span>
      </div>
      <div className="row" style={{ gap: 32, marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-value">{usd(u?.totalCostUsd ?? 0)}</span>
          <span className="stat-label">всего</span>
        </div>
        <div className="stat">
          <span className="stat-value">{(u?.totalPromptTokens ?? 0).toLocaleString("ru-RU")}</span>
          <span className="stat-label">токенов на вход</span>
        </div>
        <div className="stat">
          <span className="stat-value">{(u?.totalCompletionTokens ?? 0).toLocaleString("ru-RU")}</span>
          <span className="stat-label">токенов на выход</span>
        </div>
      </div>
      {!u?.tasks.length ? (
        <p className="faint small" style={{ margin: 0 }}>Расходов ещё нет.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Задача / действие</th>
              <th className="num">Вызовов</th>
              <th className="num">Вход</th>
              <th className="num">Выход</th>
              <th className="num">Стоимость</th>
            </tr>
          </thead>
          <tbody>
            {u.tasks.map((t: UsageByTask) => (
              <TaskRows key={t.taskId} task={t} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "hermes.turn": "работа агента",
  "hermes.tick": "обход сервисов",
  "hermes.approval": "после решения человека",
  "stagehand.llm": "браузер",
  "classify.email": "разбор письма",
  "classify.email.in-browser": "разбор письма во время браузера",
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[._]/g, " ");
}

function TaskRows({ task }: { task: UsageByTask }) {
  // Уже работающие машины собраны со старым runtime: у действия может не быть `details`.
  const notes = (action: UsageByTask["actions"][number]) => action.details ?? [];
  // Одно действие без заметок агента повторило бы строку задачи — показываем только итог.
  const breakdown = task.actions.length > 1 || task.actions.some((a) => notes(a).length > 0);
  return (
    <>
      <tr>
        <td>{task.taskTitle || task.taskId}</td>
        <td className="num">{task.calls}</td>
        <td className="num">{task.promptTokens.toLocaleString("ru-RU")}</td>
        <td className="num">{task.completionTokens.toLocaleString("ru-RU")}</td>
        <td className="num">{usd(task.costUsd)}</td>
      </tr>
      {breakdown &&
        task.actions.map((a) => (
          <tr key={a.action} className="sub">
            <td>
              {actionLabel(a.action)}
              {notes(a).length > 0 && (
                <ul className="subtasks">
                  {notes(a).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </td>
            <td className="num">{a.calls}</td>
            <td className="num">{a.promptTokens.toLocaleString("ru-RU")}</td>
            <td className="num">{a.completionTokens.toLocaleString("ru-RU")}</td>
            <td className="num">{usd(a.costUsd)}</td>
          </tr>
        ))}
    </>
  );
}
