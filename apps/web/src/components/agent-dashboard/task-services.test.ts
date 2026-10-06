import { describe, expect, it } from "vitest";
import { servicesForRun, type TaskService } from "./task-services";

const catalog: TaskService[] = [
  { slug: "linear", name: "Linear", kind: "mcp" },
  { slug: "pneumatic", name: "Pneumatic", kind: "api" },
];

describe("servicesForRun", () => {
  it("находит сервис по имени в заголовке задачи", () => {
    expect(servicesForRun(catalog, ["Приглашение: Linear"])).toEqual([catalog[0]]);
  });

  it("берёт сервис из строки подключения, даже если его нет в каталоге", () => {
    expect(servicesForRun(catalog, ["подключён сервис Notion (браузер)"])).toEqual([
      { slug: "notion", name: "Notion", kind: "browser" },
    ]);
  });

  it("не цепляет слаг внутри другого слова", () => {
    expect(servicesForRun([{ slug: "lin", name: "Lin", kind: "api" }], ["Приглашение: Linear"])).toEqual([]);
  });

  it("не дублирует сервис, если он и в каталоге, и в строке подключения", () => {
    expect(servicesForRun(catalog, ["подключён сервис Linear (MCP)", "слаг linear"])).toEqual([catalog[0]]);
  });
});
