import { describe, expect, it } from "vitest";
import { provisionVerdict } from "./provision-verdict";

describe("provisionVerdict", () => {
  it("машина стартовала после того, как ожидание вышло — агент работает", () => {
    expect(provisionVerdict("started")).toBe("running");
  });

  it("машина успела поработать и уснуть, пока статус висел в failed — тоже рабочий агент", () => {
    expect(provisionVerdict("suspended")).toBe("running");
    expect(provisionVerdict("stopped")).toBe("running");
    expect(provisionVerdict("suspending")).toBe("running");
  });

  it("первый старт ещё идёт — ждём, а не считаем ошибкой", () => {
    expect(provisionVerdict("created")).toBe("booting");
    expect(provisionVerdict("starting")).toBe("booting");
  });

  it("машины нет, она сломалась или уничтожена — ошибка остаётся", () => {
    expect(provisionVerdict(null)).toBe("leave");
    expect(provisionVerdict("failed")).toBe("leave");
    expect(provisionVerdict("destroyed")).toBe("leave");
  });
});
