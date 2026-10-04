export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Локальный next dev не должен будить боевых агентов.
  if (!process.env.FLY_APP_NAME) return;
  const { startAgentClock } = await import("./lib/agent-clock");
  startAgentClock();
}
