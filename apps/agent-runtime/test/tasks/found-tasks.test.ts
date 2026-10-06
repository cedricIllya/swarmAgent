import { describe, expect, it } from "vitest";
import { parseFoundTasks, selectNewTasks, surveySummary, taskRunTitle } from "../../src/tasks/found-tasks";

describe("parseFoundTasks", () => {
  it("reads a json list and ignores prose", () => {
    const text = [
      "Посмотрел Linear.",
      "```json",
      '{"tasks":[{"service":"linear","title":"Починить баг","detail":"LIN-12"}]}',
      "```",
    ].join("\n");
    expect(parseFoundTasks(text)).toEqual([{ service: "linear", title: "Починить баг", detail: "LIN-12" }]);
    expect(parseFoundTasks("пусто")).toEqual([]);
    expect(parseFoundTasks('{"tasks":[]}')).toEqual([]);
    expect(parseFoundTasks('{"tasks":[{"service":"linear"}]}')).toEqual([]);
  });
});

describe("taskRunTitle", () => {
  it("prefixes the service once", () => {
    expect(taskRunTitle({ service: "linear", title: "Починить баг", detail: "x" })).toBe("linear: Починить баг");
    expect(taskRunTitle({ service: "Linear", title: "Баг в Linear", detail: "x" })).toBe("Баг в Linear");
  });
});

describe("selectNewTasks", () => {
  it("skips a task that is already running", () => {
    const found = [
      { service: "linear", title: "Починить баг", detail: "LIN-12" },
      { service: "linear", title: "Починить баг", detail: "ещё раз" },
      { service: "linear", title: "Написать отчёт", detail: "LIN-13" },
    ];
    expect(selectNewTasks(found, ["linear: Починить баг"])).toEqual({
      fresh: [{ service: "linear", title: "Написать отчёт", detail: "LIN-13" }],
      already: ["linear: Починить баг"],
    });
  });
});

describe("surveySummary", () => {
  it("names the queue instead of the model json", () => {
    expect(surveySummary('{"tasks":[]}', [], [])).toBe("пусто");
    expect(surveySummary("пусто", [], [])).toBe("пусто");
    expect(surveySummary("{}", ["linear: Починить баг"], [])).toBe("В работе: linear: Починить баг");
    expect(surveySummary("{}", [], ["linear: Починить баг"])).toBe("Уже в работе: linear: Починить баг");
  });
});
