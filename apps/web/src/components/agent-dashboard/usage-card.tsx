import type { RuntimeState, UsageByTask } from "@swarm/contracts";
import { formatNumber, t, type MessageKey } from "@/i18n";
import { UsageBodySkeleton } from "../skeleton";
import { usd } from "./format";
import { presentDetails } from "./present-steps";

const ACTION_KEY: Record<string, MessageKey> = {
  "hermes.turn": "usage.action.hermesTurn",
  "hermes.tick": "usage.action.hermesTick",
  "hermes.approval": "usage.action.hermesApproval",
  "hermes.question": "usage.action.hermesQuestion",
  "stagehand.llm": "usage.action.stagehandLlm",
  "classify.email": "usage.action.classifyEmail",
  "classify.email.in-browser": "usage.action.classifyEmailBrowser",
  "classify.chat": "usage.action.classifyChat",
};

function actionLabel(action: string): string {
  const key = ACTION_KEY[action];
  return key ? t(key) : t("usage.action.other");
}

export function UsageCard({ state, pending }: { state: RuntimeState | null; pending: boolean }) {
  const u = state?.usage;
  return (
    <section className="card" aria-busy={pending}>
      <div className="card-head">
        <h2>{t("usage.title")}</h2>
        <span className="muted small">{t("usage.byTask")}</span>
      </div>
      {pending ? (
        <UsageBodySkeleton />
      ) : (
        <>
          <div className="row" style={{ gap: 32, marginBottom: 16 }}>
            <div className="stat">
              <span className="stat-value">{usd(u?.totalCostUsd ?? 0)}</span>
              <span className="stat-label">{t("usage.total")}</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatNumber(u?.totalPromptTokens ?? 0)}</span>
              <span className="stat-label">{t("usage.prompt")}</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatNumber(u?.totalCompletionTokens ?? 0)}</span>
              <span className="stat-label">{t("usage.completion")}</span>
            </div>
          </div>
          {!u?.tasks.length ? (
            <p className="faint small" style={{ margin: 0 }}>{t("usage.empty")}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t("usage.taskAction")}</th>
                  <th className="num">{t("usage.calls")}</th>
                  <th className="num">{t("usage.input")}</th>
                  <th className="num">{t("usage.output")}</th>
                  <th className="num">{t("usage.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {u.tasks.map((t: UsageByTask) => (
                  <TaskRows key={t.taskId} task={t} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function TaskRows({ task }: { task: UsageByTask }) {
  const notes = (action: UsageByTask["actions"][number]) => presentDetails(action.details ?? []);
  const breakdown = task.actions.length > 1 || task.actions.some((a) => notes(a).length > 0);
  return (
    <>
      <tr>
        <td>{task.taskTitle || task.taskId}</td>
        <td className="num">{task.calls}</td>
        <td className="num">{formatNumber(task.promptTokens)}</td>
        <td className="num">{formatNumber(task.completionTokens)}</td>
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
            <td className="num">{formatNumber(a.promptTokens)}</td>
            <td className="num">{formatNumber(a.completionTokens)}</td>
            <td className="num">{usd(a.costUsd)}</td>
          </tr>
        ))}
    </>
  );
}
