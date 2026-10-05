"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type { Agent, ChatMessage, ChatThread, Run, RunStep, RuntimeState } from "@swarm/contracts";
import { useConfirm } from "../confirm-dialog";
import { ApprovalRow } from "./approval-bubbles";
import { ChatList } from "./chat-list";
import { ChatMessages } from "./chat-messages";
import { ChatTitle } from "./chat-title";
import type { ChatMessageEvent, LiveActions } from "./use-agent-live";

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.at === b.at && a.role === b.role && a.text === b.text;
}

function runBelongs(run: Run, chat: ChatThread | null): boolean {
  if (!chat) return false;
  if (run.trigger === "chat") return run.threadId === chat.id;
  return chat.kind === "mail";
}

export function ChatCard({
  agent,
  state,
  onChatMessage,
  actionsBySession,
  stepsByRun,
}: {
  agent: Agent;
  state: RuntimeState | null;
  onChatMessage: { current: (event: ChatMessageEvent) => void };
  actionsBySession: LiveActions;
  stepsByRun: Record<string, RunStep[]>;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const confirm = useConfirm();
  const selected = params.get("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [autonomous, setAutonomous] = useState(agent.autonomous);
  const [awaiting, setAwaiting] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const chats = state?.chats ?? [];
  const activeId = selected && selected !== "new" && chats.some((c) => c.id === selected) ? selected : null;
  const active = chats.find((c) => c.id === activeId) ?? null;

  function select(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("chat", id);
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  useEffect(() => {
    if (selected === "new") return;
    if (selected && chats.some((c) => c.id === selected)) return;
    const first = chats[0];
    if (first) select(first.id);
    // select стабилен относительно текущего query; чаты приходят потоком.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, selected]);

  useEffect(() => {
    setAutonomous(agent.autonomous);
  }, [agent.autonomous]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancel = false;
    void fetch(`/api/agents/${agent.id}/chats/${activeId}`, { cache: "no-store" }).then(async (res) => {
      if (!res.ok || cancel) return;
      setMessages((await res.json()) as ChatMessage[]);
    });
    return () => {
      cancel = true;
    };
  }, [agent.id, activeId]);

  useEffect(() => {
    onChatMessage.current = (event) => {
      if (event.chatId !== activeId) return;
      setMessages((prev) => (prev.some((m) => sameMessage(m, event.message)) ? prev : [...prev, event.message]));
    };
  }, [activeId, onChatMessage]);

  useEffect(() => {
    setAwaiting(false);
  }, [activeId]);

  useEffect(() => {
    if (messages.at(-1)?.role === "agent") setAwaiting(false);
  }, [messages]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setAwaiting(true);
    const res = await fetch(`/api/agents/${agent.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, ...(activeId ? { chatId: activeId } : {}) }),
    });
    setText("");
    setBusy(false);
    if (!res.ok) {
      setAwaiting(false);
      return;
    }
    const data = (await res.json()) as { chatId: string };
    if (data.chatId && data.chatId !== activeId) select(data.chatId);
  }

  async function toggle(v: boolean) {
    setAutonomous(v);
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autonomous: v }),
    });
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

  async function rename(title: string) {
    if (!activeId) return;
    await fetch(`/api/agents/${agent.id}/chats/${activeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }

  async function removeChat() {
    if (!activeId) return;
    const ok = await confirm({
      title: "Удалить этот чат?",
      body: "История пропадёт.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    await fetch(`/api/agents/${agent.id}/chats/${activeId}`, { method: "DELETE" });
    select("new");
  }

  const running = agent.status === "running";
  const liveRun =
    (state?.runs ?? []).find((r) => (r.status === "running" || r.status === "queued") && runBelongs(r, active)) ?? null;
  const working = Boolean(active?.busy) || awaiting || Boolean(liveRun);
  const activity =
    (liveRun ? stepsByRun[liveRun.id]?.at(-1)?.text : undefined)?.replace(/\s+/g, " ").trim() || "Агент работает…";
  const pending = state?.pendingApprovals ?? [];
  const approvals = pending.filter((p) => !activeId || p.chatId === activeId || p.chatId === null);
  const inlineApprovalIds = new Set(
    messages.filter((m) => m.kind === "approval" && m.approvalId).map((m) => m.approvalId),
  );
  const looseApprovals = approvals.filter((p) => !inlineApprovalIds.has(p.id));

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Чаты</h2>
          <span className="muted small">У каждого чата своя история и свой контекст</span>
        </div>
        <label className="switch" title="Агент не будет спрашивать одобрение перед изменениями">
          <input type="checkbox" checked={autonomous} onChange={(e) => toggle(e.target.checked)} />
          <span className="switch-track" />
          <span className="small">Разрешать все действия без человека</span>
        </label>
      </div>

      <div className="chat-layout">
        <ChatList chats={chats} activeId={activeId} approvals={pending} onSelect={select} />

        <div>
          <ChatTitle chat={active} onRename={rename} onRemove={() => void removeChat()} />

          {looseApprovals.length > 0 && (
            <div className="list" style={{ marginBottom: 12 }}>
              {looseApprovals.map((p) => (
                <ApprovalRow key={p.id} approval={p} onDecide={(approved) => void decide(p.id, approved)} />
              ))}
            </div>
          )}

          <ChatMessages
            agent={agent}
            state={state}
            messages={messages}
            approvals={approvals}
            actionsBySession={actionsBySession}
            deciding={deciding}
            onDecide={(id, approved) => void decide(id, approved)}
            working={working}
            activity={activity}
          />

          <form onSubmit={(e) => void send(e)} className="row" style={{ marginTop: 12, alignItems: "flex-end" }}>
            <textarea
              className="textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={running ? "Ссылка-приглашение, API-ключ или задача" : "Агент ещё поднимается…"}
              disabled={!running}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(e);
              }}
            />
            <button className="btn btn-primary" type="submit" disabled={!running || busy || !text.trim()}>
              Отправить
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
