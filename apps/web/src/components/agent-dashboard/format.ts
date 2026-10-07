import { intlLocale, t } from "@/i18n";

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(intlLocale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return t("logs.durationSec", { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t("logs.durationMin", { n: min });
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  if (hours < 24) return minutes ? t("logs.durationHourMin", { h: hours, m: minutes }) : t("logs.durationHour", { h: hours });
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? t("logs.durationDayHour", { d: days, h }) : t("logs.durationDay", { d: days });
}

/** Сколько задача была в работе. Пусто, пока она ещё не завершена или ждёт человека. */
export function taskSpent(
  run: { status: string; startedAt: string; finishedAt: string | null; activeMs?: number | undefined },
  waiting: boolean,
): string {
  if (waiting) return "";
  if (run.status !== "done" && run.status !== "failed" && run.status !== "canceled") return "";
  const fallback = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : Number.NaN;
  const ms = typeof run.activeMs === "number" ? run.activeMs : fallback;
  if (!Number.isFinite(ms) || ms < 0) return "";
  return t("logs.spent", { time: formatDuration(ms) });
}

export function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
