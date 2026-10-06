import { describe, expect, it } from "vitest";
import { markVerificationApplied, verificationAlreadyApplied, verificationRunId } from "./verification-mail";

const now = Date.parse("2026-10-06T12:00:00.000Z");

function run(
  id: string,
  status: "running" | "done" | "queued",
  trigger: "email" | "chat" | "cron",
  finishedAt: string | null,
) {
  return { id, status, trigger, startedAt: "2026-10-06T11:00:00.000Z", finishedAt };
}

describe("verificationRunId", () => {
  it("пишет код в задачу, которая уже ждёт письмо", () => {
    expect(verificationRunId([run("cron", "running", "cron", null), run("old", "done", "email", "2026-10-06T11:50:00.000Z")], now, "login")).toBe(
      "login",
    );
  });

  it("берёт идущую задачу и пропускает плановую проверку", () => {
    expect(
      verificationRunId([run("tick", "running", "cron", null), run("invite", "running", "email", null)], now, null),
    ).toBe("invite");
  });

  it("дописывает в недавно законченный вход, а не открывает новую задачу", () => {
    expect(verificationRunId([run("invite", "done", "email", "2026-10-06T11:40:00.000Z")], now, null)).toBe("invite");
  });

  it("не цепляет код к задаче, которая закончилась давно", () => {
    expect(verificationRunId([run("invite", "done", "email", "2026-10-06T10:00:00.000Z")], now, null)).toBeNull();
  });
});

describe("verificationAlreadyApplied", () => {
  it("помнит письмо, которое уже отдали во вход", () => {
    markVerificationApplied("msg-1");
    expect(verificationAlreadyApplied("msg-1")).toBe(true);
    expect(verificationAlreadyApplied("msg-2")).toBe(false);
    expect(verificationAlreadyApplied(null)).toBe(false);
  });
});
