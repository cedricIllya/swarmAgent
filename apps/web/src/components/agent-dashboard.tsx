"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Agent,
  BrowserSession,
  ChatMessage,
  ChatThread,
  PendingApproval,
  Run,
  RunStep,
  RuntimeEvent,
  RuntimeState,
  UsageByTask,
} from "@swarm/contracts";
import { StatusBadge } from "./status-badge";

interface Detail {
  agent: Agent;
  state: RuntimeState | null;
  runtimeError: string | null;
  asleep?: boolean;
  waking?: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.at === b.at && a.role === b.role && a.text === b.text;
}

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

export function AgentDashboard({ initialAgent }: { initialAgent: Agent }) {
  const [detail, setDetail] = useState<Detail>({ agent: initialAgent, state: null, runtimeError: null });
  const [stepsByRun, setStepsByRun] = useState<Record<string, RunStep[]>>({});
  const [actionsBySession, setActionsBySession] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const sseAlive = useRef(false);
  const onChatMessage = useRef<(event: Extract<RuntimeEvent, { type: "chatMessage" }>) => void>(() => {});
  const router = useRouter();

  const refresh = useCallback(async (wake = false) => {
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

  const { agent, state, runtimeError, asleep, waking } = detail;

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
            {asleep && <span className="badge">спит</span>}
            {waking && <span className="badge">просыпается</span>}
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

      {asleep && (
        <div className="notice" style={{ marginBottom: 16 }}>
          Агент спит: процессор и память Fly не тарифицирует. Диск считается и во сне. Письмо, чат и одобрение будят машину.
        </div>
      )}

      {runtimeError && !asleep && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          Машина агента не отвечает: {runtimeError}
        </div>
      )}

      <EmailCard agent={agent} />
      <ChatCard agent={agent} state={state} onChatMessage={onChatMessage} />
      <ServicesCard agent={agent} state={state} />
      <LiveBrowserCard agent={agent} state={state} actionsBySession={actionsBySession} />
      <LogsCard agent={agent} state={state} stepsByRun={stepsByRun} />
      <UsageCard state={state} />
    </>
  );
}

function EmailCard({ agent }: { agent: Agent }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключение сервисов</h2>
        <span className="muted small">Пришлите инвайт на почту или вставьте ссылку и ключ в чат</span>
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

function ChatCard({
  agent,
  state,
  onChatMessage,
}: {
  agent: Agent;
  state: RuntimeState | null;
  onChatMessage: { current: (event: Extract<RuntimeEvent, { type: "chatMessage" }>) => void };
}) {
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [autonomous, setAutonomous] = useState(agent.autonomous);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
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
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/agents/${agent.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, ...(activeId ? { chatId: activeId } : {}) }),
    });
    setText("");
    setBusy(false);
    if (!res.ok) return;
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
    await fetch(`/api/agents/${agent.id}/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
  }

  async function saveTitle() {
    if (!activeId || !titleDraft.trim()) {
      setRenaming(false);
      return;
    }
    await fetch(`/api/agents/${agent.id}/chats/${activeId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: titleDraft.trim() }),
    });
    setRenaming(false);
  }

  async function removeChat() {
    if (!activeId || !confirm("Удалить этот чат? История пропадёт.")) return;
    await fetch(`/api/agents/${agent.id}/chats/${activeId}`, { method: "DELETE" });
    select("new");
  }

  const running = agent.status === "running";
  const working = Boolean(active?.busy);
  const approvals = (state?.pendingApprovals ?? []).filter((p) => !activeId || p.chatId === activeId || p.chatId === null);

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
        <div className="chat-list">
          <button className="btn btn-sm" type="button" onClick={() => select("new")}>
            Новый чат
          </button>
          {chats.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeId}
              waiting={state?.pendingApprovals.some((p) => p.chatId === c.id) ?? false}
              onSelect={() => select(c.id)}
            />
          ))}
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            {renaming ? (
              <input
                className="input"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveTitle();
                }}
              />
            ) : (
              <strong
                onDoubleClick={() => {
                  if (!active) return;
                  setTitleDraft(active.title);
                  setRenaming(true);
                }}
              >
                {active?.title ?? "Новый чат"}
              </strong>
            )}
            {activeId && (
              <button className="btn btn-sm" type="button" onClick={() => void removeChat()}>
                Удалить чат
              </button>
            )}
          </div>

          {approvals.length > 0 && (
            <div className="list" style={{ marginBottom: 12 }}>
              {approvals.map((p) => (
                <ApprovalRow key={p.id} approval={p} onDecide={(approved) => void decide(p.id, approved)} />
              ))}
            </div>
          )}

          <div className="chat">
            {!messages.length && <p className="faint small" style={{ margin: 0 }}>Сообщений пока нет. Ссылка-приглашение, ключ или задача.</p>}
            {messages.map((m, i) => (
              <div key={`${m.at}-${i}`} className={`bubble ${m.role === "user" ? "bubble-user" : "bubble-agent"}`}>
                {m.text}
                <span className="bubble-time">{fmtTime(m.at)}</span>
              </div>
            ))}
            {working && <p className="faint small" style={{ margin: 0 }}>Агент работает…</p>}
            <div ref={bottom} />
          </div>

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

function ChatListItem({
  chat,
  active,
  waiting,
  onSelect,
}: {
  chat: ChatThread;
  active: boolean;
  waiting: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`chat-list-item${active ? " active" : ""}`} onClick={onSelect}>
      <span className="row" style={{ justifyContent: "space-between", gap: 6 }}>
        <span>{chat.title}</span>
        {chat.busy && <span className="badge-dot pulse" title="агент работает" />}
        {waiting && <span className="badge badge-warn">ждёт</span>}
      </span>
      {chat.lastMessage && <span className="faint small chat-preview">{chat.lastMessage}</span>}
      <span className="faint small">{fmtTime(chat.updatedAt)}</span>
    </button>
  );
}

function ApprovalRow({ approval, onDecide }: { approval: PendingApproval; onDecide: (approved: boolean) => void }) {
  return (
    <div className="list-item" style={{ borderColor: "rgba(245,184,79,0.4)" }}>
      <div>
        <div className="small" style={{ color: "var(--warn)" }}>Нужно одобрение</div>
        <div>{approval.description}</div>
      </div>
      <div className="row">
        <button className="btn btn-sm btn-primary" onClick={() => onDecide(true)}>Да</button>
        <button className="btn btn-sm" onClick={() => onDecide(false)}>Нет</button>
      </div>
    </div>
  );
}

function ServicesCard({ agent, state }: { agent: Agent; state: RuntimeState | null }) {
  const list = state?.connectedServices ?? [];
  const kindLabel = { mcp: "MCP", api: "API", browser: "браузер" } as const;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Подключённые сервисы</h2>
        <span className="muted small">Только те, куда доступ уже сохранён</span>
      </div>
      {list.length === 0 ? (
        <p className="faint small" style={{ margin: 0 }}>
          Пока ничего. Пришлите приглашение на <code>{agent.email}</code> или вставьте ссылку и ключ в чат.
        </p>
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.slug} className="list-item">
              <div>
                <div>{s.name}</div>
                <div className="faint small mono">{s.slug}</div>
              </div>
              <span className="badge">{kindLabel[s.kind]}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function actionLine(action: Record<string, unknown>): string {
  const type = String(action.type ?? "шаг");
  const extra = action.url ?? action.instruction ?? action.kind ?? "";
  return extra ? `${type}: ${String(extra)}` : type;
}

function LiveBrowserCard({
  agent,
  state,
  actionsBySession,
}: {
  agent: Agent;
  state: RuntimeState | null;
  actionsBySession: Record<string, Array<Record<string, unknown>>>;
}) {
  const live = (state?.browserSessions ?? []).filter((s) => !s.finishedAt && s.liveUrl);
  const [loaded, setLoaded] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const asked = useRef(new Set<string>());

  useEffect(() => {
    for (const session of live) {
      if (asked.current.has(session.id)) continue;
      asked.current.add(session.id);
      void fetch(`/api/agents/${agent.id}/browser-sessions/${session.id}/actions`).then(async (res) => {
        if (!res.ok) return;
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        setLoaded((prev) => ({ ...prev, [session.id]: rows }));
      });
    }
  }, [agent.id, live]);

  if (!live.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Сейчас в браузере</h2>
        <span className="muted small">Живой экран сессии</span>
      </div>
      {live.map((session) => {
        const actions = [...(loaded[session.id] ?? []), ...(actionsBySession[session.id] ?? [])];
        return (
          <div key={session.id} style={{ marginBottom: 16 }}>
            <div className="small muted" style={{ marginBottom: 8 }}>{session.purpose}</div>
            <iframe
              className="live-frame"
              src={session.liveUrl ?? undefined}
              sandbox="allow-same-origin allow-scripts"
              allow="clipboard-read; clipboard-write"
              title={session.purpose}
            />
            <div className="steps">
              {actions.slice(-12).map((a, i) => (
                <div key={i} className="step">{actionLine(a)}</div>
              ))}
            </div>
          </div>
        );
      })}
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

function LogsCard({
  agent,
  state,
  stepsByRun,
}: {
  agent: Agent;
  state: RuntimeState | null;
  stepsByRun: Record<string, RunStep[]>;
}) {
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
            <RunItem
              key={r.id}
              agent={agent}
              run={r}
              sessions={sessionsByRun.get(r.id) ?? []}
              liveSteps={stepsByRun[r.id] ?? []}
            />
          ))}
        </div>
      )}
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
        {loaded === null && liveSteps.length === 0 && <span className="step">загрузка…</span>}
        {steps.map((s, i) => (
          <div key={`${s.at}-${i}`} className="step">
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
  "classify.chat": "разбор сообщения",
};

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/[._]/g, " ");
}

function TaskRows({ task }: { task: UsageByTask }) {
  const notes = (action: UsageByTask["actions"][number]) => action.details ?? [];
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
