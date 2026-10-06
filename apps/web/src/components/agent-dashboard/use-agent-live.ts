"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, ChatMessage, RunStep, RuntimeEvent, RuntimeState } from "@swarm/contracts";

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
  const onChatMessage = useRef<(event: ChatMessageEvent) => void>(() => {});

  const refresh = useCallback(async (wake = false) => {
    try {
      const res = await fetch(`/api/agents/${initialAgent.id}${wake ? "?wake=1" : ""}`, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Detail;
      setDetail((prev) => {
        const keepState = sseAlive.current || (next.asleep && !next.state);
        return {
          ...next,
          state: keepState ? (prev.state ?? next.state) : next.state,
        };
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
      setSettled(true);
      setDetail((prev) => ({ ...prev, state: event.state, asleep: false, waking: false, runtimeError: null }));
    });
    on("run", (event) => {
      if (event.type !== "run") return;
      patch((state) => {
        const runs = [event.run, ...state.runs.filter((r) => r.id !== event.run.id)];
        runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return { ...state, runs };
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
      setDetail((prev) => ({ ...prev, asleep: true }));
    });
    on("asleep", () => {
      sseAlive.current = false;
      setSettled(true);
      setDetail((prev) => ({ ...prev, asleep: true, waking: false }));
    });
    on("waking", () => {
      setDetail((prev) => ({ ...prev, waking: true, asleep: false }));
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

  return { detail, stepsByRun, messagesByRun, actionsBySession, onChatMessage, livePending, patchAgent };
}
