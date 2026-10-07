"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { Agent, BrowserSession, ChatMessage, PendingApproval, Run, RunStep, RuntimeState, UserQuestion } from "@swarm/contracts";
import { parseUserQuestion } from "@swarm/contracts";
import { count, t, type MessageKey } from "@/i18n";
import { ApprovalRow, QuestionCard } from "./approval-bubbles";
import { SessionShots } from "./browser-bubble";
import { fmtTime } from "./format";
import { SecretValue, StepText } from "./secret-value";
import { TaskWatchTag } from "../task-watch-tag";
import { accessKindLabel, type AgentAccess } from "./agent-access";
import { presentSteps, forPerson } from "./present-steps";
import { servicesForRun } from "./task-services";
import { ListSkeleton, Skeleton } from "../skeleton";
import { partitionTaskLog, waitingOnPerson, type TaskLogTone } from "./task-log-list";

const STATUS_CLASS: Record<Run["status"], string> = {
  queued: "",
  running: "badge-accent",
  waiting_approval: "badge-warn",
  done: "badge-ok",
  failed: "badge-danger",
  escalated: "badge-warn",
  canceled: "",
};

const STATUS_KEY: Record<Run["status"], MessageKey> = {
  queued: "runs.status.queued",
  running: "runs.status.running",
  waiting_approval: "runs.status.waiting_approval",
  done: "runs.status.done",
  failed: "runs.status.failed",
  escalated: "runs.status.escalated",
  canceled: "runs.status.canceled",
};

const TRIGGER_KEY: Record<Run["trigger"], MessageKey> = {
  email: "runs.trigger.email",
  chat: "runs.trigger.chat",
  cron: "runs.trigger.cron",
  approval: "runs.trigger.approval",
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
  runKey,
}: {
  agent: Agent;
  state: RuntimeState | null;
  stepsByRun: Record<string, RunStep[]>;
  messagesByRun: Record<string, ChatMessage[]>;
  pending: boolean;
  accesses: AgentAccess[];
  accessReady: boolean;
  runKey: (id: string) => string;
}) {
  const runs = state?.runs ?? [];
  const approvals = state?.pendingApprovals ?? [];
  const ranked = runs.map((run) => ({
    run,
    tone: runTone(run, runs, approvals, messagesByRun[run.id] ?? []),
  }));
  const openIds = useRef(new Set<string>());
  const pinned = useRef(new Map<string, "attention" | "live">());
  const rows = useRef(new Map<string, HTMLDetailsElement>());
  const scrollAnchor = useRef<{ key: string; top: number } | null>(null);
  const [, setOpenVersion] = useState(0);
  const onOpenChange = useCallback((key: string, open: boolean) => {
    const ids = openIds.current;
    if (ids.has(key) === open) return;
    if (open) ids.add(key);
    else ids.delete(key);
    setOpenVersion((version) => version + 1);
  }, []);
  const registerRow = useCallback((key: string, node: HTMLDetailsElement | null) => {
    if (node) rows.current.set(key, node);
    else rows.current.delete(key);
  }, []);
  const { top: openRuns, archive: settledRuns } = partitionTaskLog(
    ranked.map((item) => ({ key: runKey(item.run.id), tone: item.tone, value: item })),
    (key) => openIds.current.has(key),
    pinned.current,
  );
  const openNeedsPerson = openRuns.some((item) => item.tone === "attention");

  useEffect(() => {
    const remember = () => {
      scrollAnchor.current = visibleOpenRow(rows.current);
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, []);

  useLayoutEffect(() => {
    const prev = scrollAnchor.current;
    const next = visibleOpenRow(rows.current);
    if (prev && next && prev.key === next.key) {
      const delta = next.top - prev.top;
      if (Math.abs(delta) > 1) {
        window.scrollBy(0, delta);
        const top = rows.current.get(prev.key)?.getBoundingClientRect().top;
        scrollAnchor.current = { key: prev.key, top: top ?? next.top - delta };
        return;
      }
    }
    scrollAnchor.current = next;
  });
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
      if (!res.ok) throw new Error(t("logs.replyFailed"));
    } finally {
      setDeciding(null);
    }
  }

  function renderRun(run: Run, tone: RunTone) {
    const key = runKey(run.id);
    return (
      <Suspense
        key={key}
        fallback={
          <div className="list-item">
            <Skeleton width="52%" height={16} />
          </div>
        }
      >
        <RunItem
          agent={agent}
          run={run}
          runs={runs}
          tone={tone}
          listKey={key}
          initiallyOpen={openIds.current.has(key) || tone === "attention"}
          sessions={sessionsByRun.get(run.id) ?? []}
          liveSteps={stepsByRun[run.id] ?? []}
          liveMessages={messagesByRun[run.id] ?? []}
          approvals={approvals.filter((p) => p.runId === run.id)}
          accesses={accesses}
          deciding={deciding}
          onDecide={(id, approved) => void decide(id, approved)}
          onAnswer={(id, text) => answer(id, text)}
          onOpenChange={(open) => onOpenChange(key, open)}
          registerRow={registerRow}
        />
      </Suspense>
    );
  }

  return (
    <section className="card" aria-busy={pending}>
      <div className="card-head">
        <h2>{t("logs.title")}</h2>
        {pending ? (
          <Skeleton width={64} height={14} />
        ) : (
          <div className="row" style={{ gap: 8 }}>
            {openRuns.length > 0 && (
              <span className={`badge ${openNeedsPerson ? "badge-warn" : "badge-accent"}`}>
                {t("logs.inProgressCount", { count: openRuns.length })}
              </span>
            )}
            <span className="muted small">{count(runs.length, "tasks")}</span>
          </div>
        )}
      </div>
      {pending ? (
        <ListSkeleton />
      ) : runs.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          {t("logs.empty")}
        </p>
      ) : (
        <>
          {openRuns.length > 0 && (
            <div className="run-section">
              <div className="run-section-label">
                <span>{t("logs.inProgress")}</span>
                <span>{openRuns.length}</span>
              </div>
              <div className="list">{openRuns.map(({ run, tone }) => renderRun(run, tone))}</div>
            </div>
          )}
          {settledRuns.length > 0 &&
            (openRuns.length > 0 ? (
              <details className="run-archive">
                <summary className="run-archive-summary">
                  <span>{t("logs.settled")}</span>
                  <span className="run-archive-count">{settledRuns.length}</span>
                </summary>
                <div className="list">{settledRuns.map(({ run, tone }) => renderRun(run, tone))}</div>
              </details>
            ) : (
              <div className="list">{settledRuns.map(({ run, tone }) => renderRun(run, tone))}</div>
            ))}
        </>
      )}

      <div className="logs-access">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <div className="run-block-label" style={{ marginBottom: 0 }}>
            {t("logs.access")}
          </div>
          <Link href="/services" className="small">
            {t("logs.allServices")}
          </Link>
        </div>
        {pending || !accessReady ? (
          <ListSkeleton count={1} />
        ) : accesses.length === 0 ? (
          <p className="faint small" style={{ margin: 0 }}>
            {t("logs.accessEmptyBefore")} <code>{agent.email}</code> {t("logs.accessEmptyAfter")}
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
          <TaskWatchTag watchesTasks={login.watchesTasks} channel={login.channel} />
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
  tone,
  listKey,
  initiallyOpen,
  sessions,
  liveSteps,
  liveMessages,
  approvals,
  accesses,
  deciding,
  onDecide,
  onAnswer,
  onOpenChange,
  registerRow,
}: {
  agent: Agent;
  run: Run;
  runs: Run[];
  tone: RunTone;
  listKey: string;
  initiallyOpen: boolean;
  sessions: BrowserSession[];
  liveSteps: RunStep[];
  liveMessages: ChatMessage[];
  approvals: PendingApproval[];
  accesses: AgentAccess[];
  deciding: string | null;
  onDecide: (id: string, approved: boolean) => void;
  onAnswer: (id: string, text: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  registerRow: (key: string, node: HTMLDetailsElement | null) => void;
}) {
  const [loaded, setLoaded] = useState<RunStep[] | null>(null);
  const [loadedMessages, setLoadedMessages] = useState<ChatMessage[]>([]);
  const [stopping, setStopping] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const openRef = useRef(initiallyOpen);
  const suppressToggle = useRef(false);
  const commitPhase = useRef(true);
  const onOpenChangeRef = useRef(onOpenChange);
  const listKeyRef = useRef(listKey);
  onOpenChangeRef.current = onOpenChange;
  listKeyRef.current = listKey;
  commitPhase.current = true;

  const setDetailsRef = useCallback(
    (node: HTMLDetailsElement | null) => {
      detailsRef.current = node;
      if (node && node.open !== openRef.current) {
        suppressToggle.current = true;
        node.open = openRef.current;
        suppressToggle.current = false;
      }
      registerRow(listKeyRef.current, node);
    },
    [registerRow],
  );

  async function load() {
    if (run.id.startsWith("local_")) return;
    try {
      const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}`);
      if (!res.ok) {
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"D",location:"logs-card.tsx:load",message:"run steps failed",data:{status:res.status,runStatus:run.status},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return;
      }
      const steps = ((await res.json()) as { steps: RunStep[] }).steps;
      setLoaded(steps);
      // #region agent log
      fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"D",location:"logs-card.tsx:load",message:"run steps loaded",data:{status:res.status,runStatus:run.status,steps:steps.length,liveSteps:liveSteps.length},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } catch (e) {
      // #region agent log
      fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"D",location:"logs-card.tsx:load",message:"run steps threw",data:{error:String(e instanceof Error?e.message:e).slice(0,160),runStatus:run.status},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
  }

  async function loadHistory() {
    // У письма threadId — Message-ID, не чат. Запрос к /chats/<id> даёт 404 и прячет текст задачи.
    if (run.trigger !== "chat" || !run.threadId) return;
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
    setActionError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}/cancel`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(data?.error ?? t("logs.stopFailed"));
      }
    } finally {
      setStopping(false);
    }
  }

  async function retry(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!run.threadId || retrying) return;
    setRetrying(true);
    setActionError(null);
    const res = await fetch(`/api/agents/${agent.id}/chats/${run.threadId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id }),
    });
    setRetrying(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setActionError(data?.error ?? t("logs.retryFailed"));
    }
  }

  async function answerRun(text: string) {
    setReplying(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? t("logs.replyFailed"));
      }
    } finally {
      setReplying(false);
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
  const awaitsPerson = waitingOnPerson(run.status, pendingQuestion || Boolean(followup) || approvals.length > 0);
  const st = awaitsPerson ? { text: t("logs.inProgressBadge"), cls: "badge-warn" } : { text: t(STATUS_KEY[run.status]), cls: STATUS_CLASS[run.status] };

  const toneNow: RunTone = pendingQuestion || followup ? "attention" : tone;

  useLayoutEffect(() => {
    const node = detailsRef.current;
    if (node && openRef.current && !node.open) {
      suppressToggle.current = true;
      node.open = true;
      suppressToggle.current = false;
    }
    commitPhase.current = false;
  });

  useEffect(() => {
    if (toneNow !== "attention") return;
    openRef.current = true;
    const node = detailsRef.current;
    if (node && !node.open) {
      suppressToggle.current = true;
      node.open = true;
      suppressToggle.current = false;
    }
    onOpenChangeRef.current(true);
    void load();
    void loadHistory();
    // load зависит от run.id, который стабилен для этого элемента.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.id, followup?.prompt, toneNow]);
  const usedServices = servicesForRun(
    accesses.map((login) => ({ slug: login.slug, name: login.name, kind: login.kind })),
    [run.title, run.summary, ...steps.map((s) => s.text), ...messages.map((m) => m.text), ...sessions.map((s) => s.purpose)],
  );
  const summary = forPerson(run.summary);
  const shownSteps = presentSteps(steps);
  const local = run.id.startsWith("local_");
  const canStop =
    !local &&
    (run.status === "running" || run.status === "queued" || run.status === "waiting_approval" || run.status === "escalated");
  const canRetry =
    agent.status === "running" &&
    run.trigger === "chat" &&
    Boolean(run.threadId) &&
    (run.status === "failed" || run.status === "canceled" || run.status === "escalated") &&
    approvals.length === 0 &&
    !threadBusy;
  // Задача ещё в работе: без карточки с кнопками человек пишет решение, и агент продолжает её же.
  const escalation =
    run.status === "escalated" && !local && agent.status === "running" && approvals.length === 0 && !followup && !threadBusy
      ? summary || t("logs.inProgressWaiting")
      : null;

  return (
    <details
      className={`list-item run-row run-${toneNow}`}
      ref={setDetailsRef}
      onToggle={(event) => {
        event.stopPropagation();
        if (event.target !== event.currentTarget) return;
        if (commitPhase.current || suppressToggle.current) return;
        const node = event.currentTarget;
        openRef.current = node.open;
        onOpenChangeRef.current(node.open);
        if (node.open) {
          void load();
          void loadHistory();
        }
      }}
    >
      <summary className="run-summary">
        <div className="run-summary-main">
          <div className="run-title">{run.title}</div>
          <div className="faint small">
            {fmtTime(run.startedAt)} · {t(TRIGGER_KEY[run.trigger])}
            {sessions.length ? t("logs.browserCount", { count: sessions.length }) : ""}
            {waitNote(run, approvals.length > 0, pendingQuestion, Boolean(followup))}
            {usedServices.length ? ` · ${usedServices.map((s) => s.name).join(", ")}` : ""}
          </div>
        </div>
        <div className="run-summary-side">
          {canRetry && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={retrying} onClick={(e) => void retry(e)}>
              {retrying ? t("common.ellipsis") : t("logs.retry")}
            </button>
          )}
          {canStop && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={stopping} onClick={(e) => void stop(e)}>
              {stopping ? t("common.ellipsis") : t("logs.stop")}
            </button>
          )}
          <span className={`badge ${st.cls}`}>
            {(awaitsPerson || (run.status === "running" && toneNow === "live")) && <span className="badge-dot pulse" />}
            {st.text}
          </span>
        </div>
      </summary>
      <div className="run-body">
      {actionError && (
        <p className="small" style={{ margin: "8px 0 0", color: "var(--danger)" }}>
          {actionError}
        </p>
      )}
      {followup && (
        <div className="list" style={{ marginTop: 10 }}>
          <QuestionCard
            prompt={followup.prompt}
            options={followup.options}
            busy={replying}
            onAnswer={async (text) => {
              // У письма threadId — Message-ID, не чат. Ответ остаётся в этой задаче.
              if (run.trigger === "chat" && run.threadId) {
                setReplying(true);
                try {
                  const res = await fetch(`/api/agents/${agent.id}/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: text, chatId: run.threadId }),
                  });
                  if (!res.ok) {
                    const data = (await res.json().catch(() => null)) as { error?: string } | null;
                    throw new Error(data?.error ?? t("logs.replyFailed"));
                  }
                } finally {
                  setReplying(false);
                }
                return;
              }
              await answerRun(text);
            }}
          />
        </div>
      )}
      {escalation && (
        <div className="list" style={{ marginTop: 10 }}>
          <QuestionCard
            title={t("logs.needsPerson")}
            prompt={escalation}
            options={[]}
            busy={replying}
            placeholder={t("logs.needsPersonPlaceholder")}
            onAnswer={answerRun}
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
          <div className="run-block-label">{t("logs.services")}</div>
          <div className="service-chips">
            {usedServices.map((s) => (
              <span key={s.slug} className="service-chip">
                {s.name}
                <span className="badge">{accessKindLabel(s.kind)}</span>
                <TaskWatchTag
                  watchesTasks={accesses.find((login) => login.slug === s.slug)?.watchesTasks}
                  channel={accesses.find((login) => login.slug === s.slug)?.channel}
                />
              </span>
            ))}
          </div>
        </div>
      )}
      {history.length > 0 && (
        <div className="run-block">
          <div className="run-block-label">{t("logs.history")}</div>
          {history.map((m, i) => {
            const text = m.role === "user" ? m.text : forPerson(m.text);
            if (!text) return null;
            return (
              <div key={`${m.at}-${i}`} className="history-line">
                <span className="history-role">{m.role === "user" ? m.author || t("common.you") : t("common.agent")}</span>
                <div>
                  <StepText text={text} />
                </div>
                <span className="faint small">{fmtTime(m.at)}</span>
              </div>
            );
          })}
        </div>
      )}
      {summary && !followup && !escalation && !(pendingQuestion && run.summary.startsWith("Ждёт ответа:")) && (
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
            {t("access.browser")} · {sessionPurpose(s.purpose)} · {fmtTime(s.startedAt)}
          </div>
          {s.hasVideo ? (
            <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${s.id}/video`} />
          ) : !s.finishedAt && s.liveUrl ? (
            <a className="small" href={s.liveUrl} target="_blank" rel="noopener noreferrer">
              {t("logs.sessionLive")}
            </a>
          ) : s.provider !== "skyvern" ? (
            <SessionShots
              agentId={agent.id}
              sessionId={s.id}
              fallback={s.finishedAt ? t("logs.noFrames") : t("logs.frameAfterStep")}
            />
          ) : (
            <span className="faint small">{s.finishedAt ? t("logs.videoUnavailable") : t("logs.videoAfter")}</span>
          )}
        </div>
      ))}
      </div>
    </details>
  );
}

function questionInRun(summary: string, messages: ChatMessage[]): UserQuestion | null {
  const agent = [...messages].reverse().find((m) => m.role === "agent" && (!m.kind || m.kind === "text"));
  return parseUserQuestion(agent?.text ?? "") ?? parseUserQuestion(summary);
}

function sessionPurpose(purpose: string): string {
  if (purpose === "signup") return t("logs.purposeSignup");
  if (purpose === "login") return t("logs.purposeLogin");
  return purpose;
}

type RunTone = TaskLogTone;

function visibleOpenRow(rows: Map<string, HTMLDetailsElement>): { key: string; top: number } | null {
  const mid = window.innerHeight / 2;
  let best: { key: string; top: number; dist: number } | null = null;
  for (const [key, node] of rows) {
    if (!node.isConnected || !node.open) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
    const dist = Math.abs(rect.top - mid);
    if (!best || dist < best.dist) best = { key, top: rect.top, dist };
  }
  return best ? { key: best.key, top: best.top } : null;
}

function waitNote(run: Run, hasApproval: boolean, pendingQuestion: boolean, followup: boolean): string {
  if (hasApproval) return pendingQuestion ? t("logs.waitAnswer") : t("logs.waitPerson");
  if (followup) return t("logs.waitAnswer");
  if (run.status === "escalated") return t("logs.waitDecision");
  if (run.status === "waiting_approval") return t("logs.waitApproval");
  return "";
}

function runTone(run: Run, runs: Run[], approvals: PendingApproval[], messages: ChatMessage[]): RunTone {
  if (waitingOnPerson(run.status, approvals.some((item) => item.runId === run.id))) {
    return "attention";
  }
  if (run.status === "running" || run.status === "queued") return "live";
  if (followupQuestion(run, runs, messages)) return "attention";
  return "settled";
}

function followupQuestion(run: Run, runs: Run[], messages: ChatMessage[]): boolean {
  if (!run.threadId) return false;
  if (run.status !== "done" && run.status !== "failed" && run.status !== "escalated") return false;
  const threadBusy = runs.some(
    (item) =>
      item.threadId === run.threadId &&
      (item.status === "running" || item.status === "queued" || item.status === "waiting_approval"),
  );
  if (threadBusy) return false;
  return Boolean(questionInRun(run.summary, messages.filter((message) => message.kind !== "browser")));
}
