/**
 * Один профиль Chromium — один процесс. Второй запуск на том же userDataDir падает
 * («Chrome exited before its debugging port was ready», код 21): так ломался перенос cookies
 * из Skyvern, пока плановая проверка держала браузер того же сервиса.
 */
const locks = new Map<string, Promise<void>>();

export async function acquireProfile(dir: string, timeoutMs = 60_000): Promise<() => void> {
  const prev = locks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  locks.set(dir, chained);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`профиль браузера занят другой сессией: ${dir}`)), timeoutMs);
  });
  try {
    await Promise.race([prev, timeout]);
  } catch (e) {
    release();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
    if (locks.get(dir) === chained) locks.delete(dir);
  };
}

/** Для тестов. */
export function profileLocksHeld(): number {
  return locks.size;
}
