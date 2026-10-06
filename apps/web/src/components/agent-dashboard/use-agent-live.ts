"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, ChatMessage, Run, RunStep, RuntimeEvent, RuntimeState } from "@swarm/contracts";
import { adoptStagedRun, mergeLiveRun } from "./stage-run";
import { runListKey, transferRunKey } from "./task-log-list";

export interface Detail {
  agent: Agent;
  state: RuntimeState | null;
  runtimeError: string | null;
  asleep?: boolean;
  waking?: boolean;
}

export type ChatMessageEvent = Extract<RuntimeEvent, { type: "chatMessage" }>;
export type LiveActions = Record<string, Array<Record<string, unknown>>>;

/**
 * Живое состояние карточки агента: редкий опрос `/api/agents/:id` плюс поток SSE.
 * Пока поток жив, опрос не затирает состояние — события точнее снимка.
 */
export function useAgentLive(initialAgent: Agent) {
  const [detail, setDetail] = useState<Detail>({ agent: initialAgent, state: null, runtimeError: null });
  const [settled, setSettled] = useState(false);
  const [stepsByRun, setStepsByRun] = useState<Record<string, RunStep[]>>({});
  const [messagesByRun, setMessagesByRun] = useState<Record<string, ChatMessage[]>>({});
  const [actionsBySession, setActionsBySession] = useState<LiveActions>({});
  const sseAlive = useRef(false);
  const snapshotAt = useRef<number | null>(null);
  const onChatMessage = useRef<(event: ChatMessageEvent) => void>(() => {});
  const pendingLocal = useRef(new Map<string, Run>());
  const stableKeys = useRef(new Map<string, string>());
  const runKey = useCallback((id: string) => runListKey(stableKeys.current, id), []);

  const refresh = useCallback(async (wake = false) => {
    try {
      const res = await fetch(`/api/agents/${initialAgent.id}${wake ? "?wake=1" : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Detail;
      setDetail((prev) => {
        // Спящая и зависшая машина состояния не отдают: последний журнал остаётся на экране.
        const keepState = sseAlive.current || (!next.state && (next.asleep || Boolean(next.runtimeError)));
        const prevRuns = prev.state?.runs.length ?? null;
        const nextRuns = next.state?.runs.length ?? null;
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"A",location:"use-agent-live.ts:refresh",message:"poll merge",data:{wake,keepState,sseAlive:sseAlive.current,asleep:Boolean(next.asleep),waking:Boolean(next.waking),prevRuns,nextRuns,prevAsleep:Boolean(prev.asleep),runtimeError:next.runtimeError?String(next.runtimeError).slice(0,160):null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        const base = keepState ? (prev.state ?? next.state) : next.state;
        if (!base) return { ...next, state: null };
        const locals = [...pendingLocal.current.values()].filter((local) => !base.runs.some((r) => r.id === local.id));
        const runs = locals.length ? [...locals, ...base.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) : base.runs;
        return { ...next, state: { ...base, runs } };
      });
    } finally {
      setSettled(true);
    }
  }, [initialAgent.id]);

  useEffect(() => {
    void refresh(true);
    const t = setInterval(() => void refresh(false), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource(`/api/agents/${initialAgent.id}/events`);
    const on = (type: RuntimeEvent["type"], apply: (event: RuntimeEvent) => void) => {
      source.addEventListener(type, (ev) => {
        try {
          apply(JSON.parse((ev as MessageEvent).data) as RuntimeEvent);
        } catch {
          // битый кадр не роняет карточку
        }
      });
    };
    const patch = (fn: (state: RuntimeState) => RuntimeState) => {
      setDetail((prev) => (prev.state ? { ...prev, state: fn(prev.state), asleep: false, waking: false } : prev));
    };
    on("snapshot", (event) => {
      if (event.type !== "snapshot") return;
      sseAlive.current = true;
      snapshotAt.current = Date.now();
      setSettled(true);
      setDetail((prev) => {
        const locals = [...pendingLocal.current.values()].filter((local) => !event.state.runs.some((r) => r.id === local.id));
        const runs = [...event.state.runs, ...locals];
        runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return { ...prev, state: { ...event.state, runs }, asleep: false, waking: false, runtimeError: null };
      });
    });
    on("run", (event) => {
      if (event.type !== "run") return;
      patch((state) => {
        const merged = mergeLiveRun(state.runs, event.run, new Set(pendingLocal.current.keys()));
        if (merged.droppedId) {
          transferRunKey(stableKeys.current, merged.droppedId, event.run.id);
          pendingLocal.current.delete(merged.droppedId);
        }
        return { ...state, runs: merged.runs };
      });
    });
    on("step", (event) => {
      if (event.type !== "step") return;
      setStepsByRun((prev) => {
        const list = prev[event.runId] ?? [];
        if (list.some((s) => s.at === event.step.at && s.text === event.step.text)) return prev;
        return { ...prev, [event.runId]: [...list, event.step] };
      });
    });
    on("chatMessage", (event) => {
      if (event.type !== "chatMessage") return;
      const runId = event.message.runId;
      if (runId) {
        setMessagesByRun((prev) => {
          const list = prev[runId] ?? [];
          if (list.some((m) => m.at === event.message.at && m.role === event.message.role && m.text === event.message.text)) return prev;
          return { ...prev, [runId]: [...list, event.message] };
        });
      }
      onChatMessage.current(event);
    });
    on("chats", (event) => {
      if (event.type !== "chats") return;
      patch((state) => ({ ...state, chats: event.chats }));
    });
    on("approvals", (event) => {
      if (event.type !== "approvals") return;
      patch((state) => ({ ...state, pendingApprovals: event.approvals }));
    });
    on("browserSession", (event) => {
      if (event.type !== "browserSession") return;
      patch((state) => {
        const rest = state.browserSessions.filter((s) => s.id !== event.session.id);
        const browserSessions = [event.session, ...rest].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return { ...state, browserSessions, busyInBrowser: browserSessions.some((s) => !s.finishedAt) };
      });
    });
    on("browserAction", (event) => {
      if (event.type !== "browserAction") return;
      setActionsBySession((prev) => {
        const list = prev[event.sessionId] ?? [];
        return { ...prev, [event.sessionId]: [...list, event.action] };
      });
    });
    on("services", (event) => {
      if (event.type !== "services") return;
      patch((state) => ({ ...state, connectedServices: event.connectedServices }));
    });
    on("sleeping", () => {
      sseAlive.current = false;
      const msSinceSnapshot = snapshotAt.current ? Date.now() - snapshotAt.current : null;
      setDetail((prev) => {
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"C",location:"use-agent-live.ts:sleeping",message:"runtime sleeping",data:{prevRuns:prev.state?.runs.length??null,hadState:Boolean(prev.state),msSinceSnapshot},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return { ...prev, asleep: true };
      });
    });
    on("asleep", () => {
      sseAlive.current = false;
      setSettled(true);
      setDetail((prev) => {
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"B",location:"use-agent-live.ts:asleep",message:"control plane asleep",data:{prevRuns:prev.state?.runs.length??null,hadState:Boolean(prev.state),settled:true},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return { ...prev, asleep: true, waking: false };
      });
    });
    on("waking", () => {
      setDetail((prev) => {
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"pre",hypothesisId:"E",location:"use-agent-live.ts:waking",message:"control plane waking",data:{prevRuns:prev.state?.runs.length??null,hadState:Boolean(prev.state)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return { ...prev, waking: true, asleep: false };
      });
    });
    on("unreachable", () => {
      sseAlive.current = false;
      setSettled(true);
      setDetail((prev) => {
        // #region agent log
        fetch("http://127.0.0.1:7513/ingest/c400658e-f748-4bbd-a80b-12efc8082a6f",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"105c57"},body:JSON.stringify({sessionId:"105c57",runId:"post-fix",hypothesisId:"B",location:"use-agent-live.ts:unreachable",message:"runtime unreachable",data:{prevRuns:prev.state?.runs.length??null,hadState:Boolean(prev.state)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return { ...prev, asleep: false, waking: false, runtimeError: prev.runtimeError ?? "runtime не отвечает" };
      });
    });
    source.onerror = () => {
      sseAlive.current = false;
    };
    return () => source.close();
  }, [initialAgent.id]);

  const livePending = detail.state === null && !settled;
  const patchAgent = useCallback((agent: Agent) => {
    setDetail((prev) => ({ ...prev, agent }));
  }, []);

  const stageChatTask = useCallback((title: string) => {
    const id = `local_${crypto.randomUUID()}`;
    const run: Run = {
      id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      trigger: "chat",
      title: title.replace(/\s+/g, " ").trim().slice(0, 120) || "Задача",
      summary: "",
      threadId: id,
    };
    pendingLocal.current.set(run.id, run);
    stableKeys.current.set(run.id, run.id);
    setDetail((prev) => {
      if (!prev.state) return prev;
      const runs = [run, ...prev.state.runs.filter((r) => r.id !== run.id)];
      runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { ...prev, state: { ...prev.state, runs }, asleep: false, waking: false };
    });
    return {
      drop() {
        pendingLocal.current.delete(run.id);
        setDetail((prev) => (prev.state ? { ...prev, state: { ...prev.state, runs: prev.state.runs.filter((r) => r.id !== run.id) } } : prev));
      },
      adopt(runId: string) {
        transferRunKey(stableKeys.current, run.id, runId);
        pendingLocal.current.delete(run.id);
        setDetail((prev) => (prev.state ? { ...prev, state: { ...prev.state, runs: adoptStagedRun(prev.state.runs, run.id, runId) } } : prev));
      },
    };
  }, []);

  return { detail, stepsByRun, messagesByRun, actionsBySession, onChatMessage, livePending, patchAgent, stageChatTask, runKey };
}
