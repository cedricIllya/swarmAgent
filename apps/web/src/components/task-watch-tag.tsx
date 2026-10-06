import { taskWatchLabel } from "./agent-dashboard/agent-access";

/** Короткий тег: смотрит ли агент в этом сервисе назначенные задачи. */
export function TaskWatchTag({ watchesTasks }: { watchesTasks: boolean | null | undefined }) {
  const label = taskWatchLabel(watchesTasks);
  return (
    <span className={label.ok ? "badge badge-ok" : "badge"} title={label.title}>
      {label.text}
    </span>
  );
}
