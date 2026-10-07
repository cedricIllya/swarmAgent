import { describe, expect, it } from "vitest";
import { POPULAR_MODEL_LIMIT, pickPopularModels } from "./models";

describe("pickPopularModels", () => {
  it("keeps the first 30 text models with tools, in catalog order", () => {
    const data = Array.from({ length: 80 }, (_, i) => ({
      id: `m/${i}`,
      name: `Model ${i}`,
      context_length: 8000,
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { output_modalities: i % 4 === 0 ? ["image"] : ["text"] },
      supported_parameters: i % 4 === 1 ? ["temperature"] : ["tools"],
    }));

    const list = pickPopularModels(data);

    expect(POPULAR_MODEL_LIMIT).toBe(30);
    expect(list).toHaveLength(30);
    expect(list[0]?.id).toBe("m/2");
    expect(list.at(-1)?.id).toBe("m/59");
    expect(list[0]).toMatchObject({ promptPerM: 1, completionPerM: 2, context: 8000 });
    expect(list.some((m) => Number(m.id.slice(2)) % 4 === 0 || Number(m.id.slice(2)) % 4 === 1)).toBe(false);
  });
});
