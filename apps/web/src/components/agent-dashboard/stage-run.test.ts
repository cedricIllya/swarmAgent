import { describe, expect, it } from "vitest";
import type { Run } from "@swarm/contracts";
import { adoptStagedRun, mergeLiveRun } from "./stage-run";

function run(partial: Pick<Run, "id" | "title"> & Partial<Run>): Run {
  return {
    startedAt: partial.startedAt ?? "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    status: "running",
    trigger: "chat",
    summary: "",
    threadId: null,
    ...partial,
  };
}

describe("staged chat task", () => {
  it("убирает самую раннюю заготовку с тем же текстом, когда приходит настоящая задача", () => {
    const older = run({ id: "local_a", title: "привет", startedAt: "2026-01-01T00:00:00.000Z" });
    const newer = run({ id: "local_b", title: "привет", startedAt: "2026-01-01T00:00:02.000Z" });
    const pending = new Set(["local_a", "local_b"]);
    const merged = mergeLiveRun([newer, older], run({ id: "run_1", title: "привет", startedAt: "2026-01-01T00:00:01.000Z" }), pending);
    expect(merged.droppedId).toBe("local_a");
    expect(merged.runs.map((r) => r.id)).toEqual(["local_b", "run_1"]);
  });

  it("подменяет заготовку id сервера и не плодит вторую строку", () => {
    const local = run({ id: "local_a", title: "привет" });
    expect(adoptStagedRun([local], "local_a", "run_1").map((r) => r.id)).toEqual(["run_1"]);
    const live = run({ id: "run_1", title: "Ключ: Linear" });
    expect(adoptStagedRun([live, local], "local_a", "run_1").map((r) => r.id)).toEqual(["run_1"]);
  });
});
