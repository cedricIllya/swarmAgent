import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdMachine, machineHeld, pinMachine } from "./fly-machines";

const g = globalThis as { __swarmMachineHolds?: Map<string, { until: number; pins: number }> };

describe("machine hold", () => {
  beforeEach(() => {
    g.__swarmMachineHolds = new Map();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    g.__swarmMachineHolds = new Map();
  });

  it("отпускает машину, когда срок удержания вышел", () => {
    holdMachine("agt", 1_000);
    expect(machineHeld("agt")).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(machineHeld("agt")).toBe(false);
  });

  it("держит машину до конца запуска, даже если срок уже вышел", () => {
    holdMachine("agt", 1_000);
    const release = pinMachine("agt");
    vi.advanceTimersByTime(5_000);
    expect(machineHeld("agt")).toBe(true);
    release();
    expect(machineHeld("agt")).toBe(false);
  });

  it("снимает удержание только когда кончились все запуски", () => {
    const first = pinMachine("agt");
    const second = pinMachine("agt");
    first();
    expect(machineHeld("agt")).toBe(true);
    second();
    expect(machineHeld("agt")).toBe(false);
  });

  it("видит pin, записанный в общую карту процесса", () => {
    g.__swarmMachineHolds = new Map([["agt", { until: 0, pins: 1 }]]);
    expect(machineHeld("agt")).toBe(true);
  });
});
