import { describe, expect, it } from "vitest";
import { provisionVerdict } from "./provision-verdict";

describe("provisionVerdict", () => {
  it("машина стартовала после того, как ожидание вышло — агент работает", () => {
    expect(provisionVerdict("failed", "started")).toBe("running");
    expect(provisionVerdict("provisioning", "started")).toBe("running");
  });

  it("первый старт ещё идёт — ждём, а не считаем ошибкой", () => {
    expect(provisionVerdict("failed", "created")).toBe("booting");
    expect(provisionVerdict("provisioning", "starting")).toBe("booting");
  });

  it("уснувшая машина: у provisioning это рабочий агент, у failed — не трогаем", () => {
    expect(provisionVerdict("provisioning", "suspended")).toBe("running");
    expect(provisionVerdict("provisioning", "stopped")).toBe("running");
    expect(provisionVerdict("failed", "stopped")).toBe("leave");
  });

  it("машины нет или она уничтожена — ошибка остаётся", () => {
    expect(provisionVerdict("failed", null)).toBe("leave");
    expect(provisionVerdict("provisioning", "destroyed")).toBe("leave");
  });
});
