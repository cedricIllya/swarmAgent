"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type MouseEvent } from "react";
import type { Agent, BrowserSession, ChatMessage, PendingApproval, Run, RunStep, RuntimeState, UserQuestion } from "@swarm/contracts";
import { parseUserQuestion } from "@swarm/contracts";
import { ApprovalRow, QuestionCard } from "./approval-bubbles";
import { SessionShots } from "./browser-bubble";
import { fmtTime } from "./format";
import { SecretValue, StepText } from "./secret-value";
import { TaskWatchTag } from "../task-watch-tag";
import { accessKindLabel, type AgentAccess } from "./agent-access";
import { presentSteps, forPerson } from "./present-steps";
import { servicesForRun } from "./task-services";
import { ListSkeleton, Skeleton } from "../skeleton";

const STATUS_LABEL: Record<Run["status"], { text: string; cls: string }> = {
  queued: { text: "в очереди", cls: "" },
  running: { text: "идёт", cls: "badge-accent" },
  waiting_approval: { text: "ждёт одобрения", cls: "badge-warn" },
  done: { text: "готово", cls: "badge-ok" },
  failed: { text: "ошибка", cls: "badge-danger" },
  escalated: { text: "нужен человек", cls: "badge-warn" },
  canceled: { text: "остановлено", cls: "" },
};

const TRIGGER_LABEL: Record<Run["trigger"], string> = {
  email: "письмо",
  chat: "задача",
  cron: "по расписанию",
  approval: "одобрение",
};

function mergeSteps(loaded: RunStep[] | null, live: RunStep[]): RunStep[] {
  const seen = new Set<string>();
  const out: RunStep[] = [];
  for (const step of [...(loaded ?? []), ...live]) {
    const key = `${step.at}\0${step.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
}

function mergeMessages(loaded: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const message of [...loaded, ...live]) {
    const key = `${message.at}\0${message.role}\0${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out;
}

export function LogsCard({
  agent,
  state,
  stepsByRun,
  messagesByRun,
  pending,
  accesses,
  accessReady,
}: {
  agent: Agent;
  state: RuntimeState | null;
  stepsByRun: Record<string, RunStep[]>;
  messagesByRun: Record<string, ChatMessage[]>;
  pending: boolean;
  accesses: AgentAccess[];
  accessReady: boolean;
}) {
  const runs = state?.runs ?? [];
  const approvals = state?.pendingApprovals ?? [];
  const [deciding, setDeciding] = useState<string | null>(null);
  const sessionsByRun = new Map<string, BrowserSession[]>();
  for (const s of state?.browserSessions ?? []) {
    const arr = sessionsByRun.get(s.runId) ?? [];
    arr.push(s);
    sessionsByRun.set(s.runId, arr);
  }

  async function decide(id: string, approved: boolean) {
    setDeciding(id);
    try {
      await fetch(`/api/agents/${agent.id}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
    } finally {
      setDeciding(null);
    }
  }

  async function answer(id: string, text: string) {
    setDeciding(id);
    try {
      const res = await fetch(`/api/agents/${agent.id}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text }),
      });
      if (!res.ok) throw new Error("Не удалось отправить ответ");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <section className="card" aria-busy={pending}>
      <div className="card-head">
        <h2>Журнал задач</h2>
        {pending ? <Skeleton width={64} height={14} /> : <span className="muted small">{runs.length} задач</span>}
      </div>
      {pending ? (
        <ListSkeleton />
      ) : runs.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          Задач ещё не было.
        </p>
      ) : (
        <div className="list">
          {runs.map((r) => (
            <Suspense
              key={r.id}
              fallback={
                <div className="list-item">
                  <Skeleton width="52%" height={16} />
                </div>
              }
            >
              <RunItem
                agent={agent}
                run={r}
                runs={runs}
                sessions={sessionsByRun.get(r.id) ?? []}
                liveSteps={stepsByRun[r.id] ?? []}
                liveMessages={messagesByRun[r.id] ?? []}
                approvals={approvals.filter((p) => p.runId === r.id)}
                accesses={accesses}
                deciding={deciding}
                onDecide={(id, approved) => void decide(id, approved)}
                onAnswer={(id, text) => answer(id, text)}
              />
            </Suspense>
          ))}
        </div>
      )}

      <div className="run-block">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <div className="run-block-label" style={{ marginBottom: 0 }}>
            Доступы
          </div>
          <Link href="/services" className="small">
            Все сервисы →
          </Link>
        </div>
        {pending || !accessReady ? (
          <ListSkeleton count={1} />
        ) : accesses.length === 0 ? (
          <p className="faint small" style={{ margin: 0 }}>
            Пока ничего. Пришлите приглашение на <code>{agent.email}</code> или вставьте ссылку и ключ в задачу.
          </p>
        ) : (
          <div className="list">
            {accesses.map((s) => (
              <AccessRow key={s.slug} login={s} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function AccessRow({ login }: { login: AgentAccess }) {
  return (
    <div className="list-item access-row">
      <div>
        <div className="row" style={{ gap: 8 }}>
          <span>{login.name}</span>
          <span className="badge">{accessKindLabel(login.kind)}</span>
          <TaskWatchTag watchesTasks={login.watchesTasks} />
        </div>
        {(login.accountName || login.accountEmail) && (
          <div className="small" style={{ marginTop: 4 }}>
            {[login.accountName, login.accountEmail].filter(Boolean).join(" · ")}
          </div>
        )}
        {login.password && (
          <div style={{ marginTop: 8 }}>
            <SecretValue kind="password" value={login.password} />
          </div>
        )}
      </div>
    </div>
  );
}

function RunItem({
  agent,
  run,
  runs,
  sessions,
  liveSteps,
  liveMessages,
  approvals,
  accesses,
  deciding,
  onDecide,
  onAnswer,
}: {
  agent: Agent;
  run: Run;
  runs: Run[];
  sessions: BrowserSession[];
  liveSteps: RunStep[];
  liveMessages: ChatMessage[];
  approvals: PendingApproval[];
  accesses: AgentAccess[];
  deciding: string | null;
  onDecide: (id: string, approved: boolean) => void;
  onAnswer: (id: string, text: string) => Promise<void>;
}) {
  const [loaded, setLoaded] = useState<RunStep[] | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<ChatMessage[]>([]);
  const [open, setOpen] = useState(needsAttention(run.status));
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);

  async function load() {
    if (run.id.startsWith("local_")) return;
    const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}`);
    if (res.ok) setLoaded(((await res.json()) as { steps: RunStep[] }).steps);
  }

  async function loadHistory() {
    if (!run.threadId) return;
    const res = await fetch(`/api/agents/${agent.id}/chats/${run.threadId}`, { cache: "no-store" });
    if (!res.ok) return;
    const all = (await res.json()) as ChatMessage[];
    setLoadedMessages(all.filter((m) => m.runId === run.id));
  }

  async function stop(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (stopping) return;
    setStopping(true);
    try {
      await fetch(`/api/agents/${agent.id}/runs/${run.id}/cancel`, { method: "POST" });
    } finally {
      setStopping(false);
    }
  }

  async function retry(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!run.threadId || retrying) return;
    setRetrying(true);
    setRetryError(null);
    const res = await fetch(`/api/agents/${agent.id}/chats/${run.threadId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id }),
    });
    setRetrying(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setRetryError(data?.error ?? "Не удалось повторить");
    }
  }

  const pendingQuestion = approvals.some((p) => p.kind === "question");
  const threadBusy = runs.some(
    (r) => r.threadId === run.threadId && (r.status === "running" || r.status === "queued" || r.status === "waiting_approval"),
  );
  const steps = mergeSteps(loaded, liveSteps);
  const messages = mergeMessages(loadedMessages, liveMessages);
  const pendingIds = new Set(approvals.map((p) => p.id));
  const history = messages.filter((m) => {
    if (m.kind === "browser") return false;
    if (m.kind === "approval" && m.role === "agent" && m.approvalId && pendingIds.has(m.approvalId)) return false;
    return true;
  });
  const followup =
    !pendingQuestion &&
    Boolean(run.threadId) &&
    !threadBusy &&
    (run.status === "done" || run.status === "failed" || run.status === "escalated")
      ? questionInRun(run.summary, history)
      : null;
  const st = pendingQuestion || followup ? { text: "ждёт ответа", cls: "badge-warn" } : STATUS_LABEL[run.status];

  useEffect(() => {
    if (needsAttention(run.status) || followup) {
      setOpen(true);
      void load();
      void loadHistory();
    }
    // load зависит от run.id, который стабилен для этого элемента.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.id, followup?.prompt]);
  const usedServices = servicesForRun(
    accesses.map((login) => ({ slug: login.slug, name: login.name, kind: login.kind })),
    [run.title, run.summary, ...steps.map((s) => s.text), ...messages.map((m) => m.text), ...sessions.map((s) => s.purpose)],
  );
  const ownAccess = accesses.filter((login) => usedServices.some((s) => s.slug === login.slug));
  const summary = forPerson(run.summary);
  const shownSteps = presentSteps(steps);
  const canStop =
    !run.id.startsWith("local_") &&
    (run.status === "running" || run.status === "queued" || run.status === "waiting_approval");
  const canRetry =
    agent.status === "running" &&
    run.trigger === "chat" &&
    Boolean(run.threadId) &&
    (run.status === "failed" || run.status === "canceled") &&
    !threadBusy;

  return (
    <details
      className="list-item"
      style={{ display: "block" }}
      open={open}
      onToggle={(e) => {
        const o = (e.target as HTMLDetailsElement).open;
        setOpen(o);
        if (o) {
          void load();
          void loadHistory();
        }
      }}
    >
      <summary className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <div>{run.title}</div>
          <div className="faint small">
            {fmtTime(run.startedAt)} · {TRIGGER_LABEL[run.trigger]}
            {sessions.length ? ` · браузер ×${sessions.length}` : ""}
            {approvals.length ? (pendingQuestion ? " · ждёт ответа" : " · ждёт человека") : followup ? " · ждёт ответа" : ""}
            {usedServices.length ? ` · ${usedServices.map((s) => s.name).join(", ")}` : ""}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexShrink: 0 }}>
          {canRetry && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={retrying} onClick={(e) => void retry(e)}>
              {retrying ? "…" : "Повторить"}
            </button>
          )}
          {canStop && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={stopping} onClick={(e) => void stop(e)}>
              {stopping ? "…" : "Остановить"}
            </button>
          )}
          <span className={`badge ${st.cls}`}>{st.text}</span>
        </div>
      </summary>
      {retryError && (
        <p className="small" style={{ margin: "8px 0 0", color: "var(--danger)" }}>
          {retryError}
        </p>
      )}
      {followup && (
        <div className="list" style={{ marginTop: 10 }}>
          <QuestionCard
            prompt={followup.prompt}
            options={followup.options}
            busy={replying}
            onAnswer={async (text) => {
              if (!run.threadId) return;
              setReplying(true);
              try {
                const res = await fetch(`/api/agents/${agent.id}/chat`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message: text, chatId: run.threadId }),
                });
                if (!res.ok) {
                  const data = (await res.json().catch(() => null)) as { error?: string } | null;
                  throw new Error(data?.error ?? "Не удалось отправить ответ");
                }
              } finally {
                setReplying(false);
              }
            }}
          />
        </div>
      )}
      {approvals.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {approvals.map((p) => (
            <ApprovalRow
              key={p.id}
              approval={p}
              busy={deciding === p.id}
              onDecide={(approved) => onDecide(p.id, approved)}
              onAnswer={(text) => onAnswer(p.id, text)}
            />
          ))}
        </div>
      )}
      {usedServices.length > 0 && (
        <div className="run-block">
          <div className="run-block-label">Сервисы</div>
          <div className="service-chips">
            {usedServices.map((s) => (
              <span key={s.slug} className="service-chip">
                {s.name}
                <span className="badge">{accessKindLabel(s.kind)}</span>
                <TaskWatchTag watchesTasks={accesses.find((login) => login.slug === s.slug)?.watchesTasks} />
              </span>
            ))}
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="run-block">
          <div className="run-block-label">История</div>
          {history.map((m, i) => {
            const text = m.role === "user" ? m.text : forPerson(m.text);
            if (!text) return null;
            return (
              <div key={`${m.at}-${i}`} className="history-line">
                <span className="history-role">{m.role === "user" ? "Вы" : "Агент"}</span>
                <div>
                  <StepText text={text} />
                </div>
                <span className="faint small">{fmtTime(m.at)}</span>
              </div>
            );
          })}
        </div>
      )}
      {ownAccess.length > 0 && (
        <div className="run-block">
          <div className="run-block-label">Доступ этой задачи</div>
          <div className="list">
            {ownAccess.map((login) => (
              <AccessRow key={login.slug} login={login} />
            ))}
          </div>
        </div>
      )}
      {summary && !followup && !(pendingQuestion && run.summary.startsWith("Ждёт ответа:")) && (
        <p className="small" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>
          <StepText text={summary} />
        </p>
      )}
      <div className="steps">
        {loaded === null && liveSteps.length === 0 && (
          <>
            <Skeleton width="78%" height={14} />
            <Skeleton width="56%" height={14} />
          </>
        )}
        {shownSteps.map((text, i) => (
          <div key={`${text}-${i}`} className="step">
            <StepText text={text} />
          </div>
        ))}
      </div>
      {sessions.map((s) => (
        <div key={s.id} style={{ marginTop: 12 }}>
          <div className="small muted">
            браузер · {sessionPurpose(s.purpose)} · {fmtTime(s.startedAt)}
          </div>
          {s.hasVideo ? (
            <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${s.id}/video`} />
          ) : !s.finishedAt && s.liveUrl ? (
            <a className="small" href={s.liveUrl} target="_blank" rel="noopener noreferrer">
              сессия идёт — смотреть браузер
            </a>
          ) : s.provider !== "skyvern" ? (
            <SessionShots
              agentId={agent.id}
              sessionId={s.id}
              fallback={s.finishedAt ? "кадров нет" : "кадр появится после шага"}
            />
          ) : (
            <span className="faint small">{s.finishedAt ? "видео недоступно" : "сессия идёт, видео появится после"}</span>
          )}
        </div>
      ))}
    </details>
  );
}

function questionInRun(summary: string, messages: ChatMessage[]): UserQuestion | null {
  const agent = [...messages].reverse().find((m) => m.role === "agent" && (!m.kind || m.kind === "text"));
  return parseUserQuestion(agent?.text ?? "") ?? parseUserQuestion(summary);
}

function sessionPurpose(purpose: string): string {
  if (purpose === "signup") return "регистрация";
  if (purpose === "login") return "вход";
  return purpose;
}

function needsAttention(status: Run["status"]): boolean {
  return status === "running" || status === "queued" || status === "waiting_approval" || status === "escalated";
}
