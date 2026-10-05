import { describe, expect, it } from "vitest";
import { shotFile } from "./shots";

describe("shotFile", () => {
  it("keeps a numbered jpeg and rejects a path", () => {
    expect(shotFile("3.jpg")).toBe("3.jpg");
    expect(shotFile("../session.json")).toBeNull();
    expect(shotFile("3.png")).toBeNull();
    expect(shotFile("")).toBeNull();
  });
});
