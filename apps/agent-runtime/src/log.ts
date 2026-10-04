export function log(scope: string, message: string, data?: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), scope, message, ...(data ?? {}) };
  console.log(JSON.stringify(line));
}

export function warn(scope: string, message: string, data?: Record<string, unknown>): void {
  const line = { at: new Date().toISOString(), level: "warn", scope, message, ...(data ?? {}) };
  console.warn(JSON.stringify(line));
}
