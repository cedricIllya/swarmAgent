import type { RuntimeState, UsageByTask } from "@swarm/contracts";
import { UsageBodySkeleton } from "../skeleton";
import { usd } from "./format";
import { presentDetail } from "./present-steps";

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
  return ACTION_LABEL[action] ?? "действие";
}

export function UsageCard({ state, pending }: { state: RuntimeState | null; pending: boolean }) {
  const u = state?.usage;
  return (
    <section className="card" aria-busy={pending}>
      <div className="card-head">
        <h2>Токены и деньги</h2>
        <span className="muted small">По задачам</span>
      </div>
      {pending ? (
        <UsageBodySkeleton />
      ) : (
        <>
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
        </>
      )}
    </section>
  );
}

function TaskRows({ task }: { task: UsageByTask }) {
  const notes = (action: UsageByTask["actions"][number]) =>
    (action.details ?? []).map(presentDetail).filter((line): line is string => Boolean(line));
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
