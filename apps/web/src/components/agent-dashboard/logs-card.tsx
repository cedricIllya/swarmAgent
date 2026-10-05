"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { Agent, BrowserSession, Run, RunStep, RuntimeState } from "@swarm/contracts";
import { fmtTime } from "./format";
import { ListSkeleton, Skeleton } from "../skeleton";

const STATUS_LABEL: Record<Run["status"], { text: string; cls: string }> = {
  queued: { text: "в очереди", cls: "" },
  running: { text: "идёт", cls: "badge-accent" },
  waiting_approval: { text: "ждёт одобрения", cls: "badge-warn" },
  done: { text: "готово", cls: "badge-ok" },
  failed: { text: "ошибка", cls: "badge-danger" },
  escalated: { text: "нужен человек", cls: "badge-warn" },
};

const TRIGGER_LABEL: Record<Run["trigger"], string> = {
  email: "письмо",
  chat: "чат",
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

export function LogsCard({
  agent,
  state,
  stepsByRun,
  pending,
}: {
  agent: Agent;
  state: RuntimeState | null;
  stepsByRun: Record<string, RunStep[]>;
  pending: boolean;
}) {
  const runs = state?.runs ?? [];
  const sessionsByRun = new Map<string, BrowserSession[]>();
  for (const s of state?.browserSessions ?? []) {
    const arr = sessionsByRun.get(s.runId) ?? [];
    arr.push(s);
    sessionsByRun.set(s.runId, arr);
  }
  return (
    <section className="card" aria-busy={pending}>
      <div className="card-head">
        <h2>Логи работы</h2>
        {pending ? <Skeleton width={64} height={14} /> : <span className="muted small">{runs.length} задач</span>}
      </div>
      <div className="stable-slot">
      {pending ? (
        <ListSkeleton />
      ) : runs.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>Задач ещё не было.</p>
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
                sessions={sessionsByRun.get(r.id) ?? []}
                liveSteps={stepsByRun[r.id] ?? []}
              />
            </Suspense>
          ))}
        </div>
      )}
      </div>
    </section>
  );
}

function RunItem({
  agent,
  run,
  sessions,
  liveSteps,
}: {
  agent: Agent;
  run: Run;
  sessions: BrowserSession[];
  liveSteps: RunStep[];
}) {
  const [loaded, setLoaded] = useState<RunStep[] | null>(null);
  const [open, setOpen] = useState(run.status === "running");
  const router = useRouter();
  const params = useSearchParams();

  async function load() {
    const res = await fetch(`/api/agents/${agent.id}/runs/${run.id}`);
    if (res.ok) setLoaded(((await res.json()) as { steps: RunStep[] }).steps);
  }

  useEffect(() => {
    if (run.status === "running") {
      setOpen(true);
      void load();
    }
    // load зависит от run.id, который стабилен для этого элемента.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.status, run.id]);

  const st = STATUS_LABEL[run.status];
  const steps = mergeSteps(loaded, liveSteps);
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
            {run.trigger === "chat" && run.threadId && (
              <>
                {" · "}
                <button
                  type="button"
                  className="linkish"
                  onClick={(e) => {
                    e.preventDefault();
                    const next = new URLSearchParams(params.toString());
                    next.set("chat", run.threadId!);
                    router.replace(`?${next.toString()}`, { scroll: false });
                  }}
                >
                  открыть чат
                </button>
              </>
            )}
          </div>
        </div>
        <span className={`badge ${st.cls}`}>{st.text}</span>
      </summary>
      {run.summary && <p className="small" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }}>{run.summary}</p>}
      <div className="steps">
        {loaded === null && liveSteps.length === 0 && (
          <>
            <Skeleton width="78%" height={14} />
            <Skeleton width="56%" height={14} />
          </>
        )}
        {steps.map((s, i) => (
          <div key={`${s.at}-${i}`} className="step">
            <b>{s.kind}</b> · {s.text}
          </div>
        ))}
      </div>
      {sessions.map((s) => (
        <div key={s.id} style={{ marginTop: 12 }}>
          <div className="small muted">
            {s.provider === "skyvern" ? "Skyvern" : "браузер"} · {s.purpose} · {fmtTime(s.startedAt)}
          </div>
          {s.hasVideo ? (
            <video controls preload="none" src={`/api/agents/${agent.id}/browser-sessions/${s.id}/video`} />
          ) : !s.finishedAt && s.liveUrl ? (
            <a className="small" href={s.liveUrl} target="_blank" rel="noopener noreferrer">
              сессия идёт — смотреть браузер
            </a>
          ) : (
            <span className="faint small">
              {s.finishedAt
                ? s.provider === "skyvern"
                  ? "видео недоступно"
                  : "шаги в журнале задачи"
                : s.provider === "skyvern"
                  ? "сессия идёт, видео появится после"
                  : "сессия идёт"}
            </span>
          )}
        </div>
      ))}
    </details>
  );
}
