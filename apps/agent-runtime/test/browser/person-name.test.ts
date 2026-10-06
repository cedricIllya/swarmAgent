import { describe, expect, it } from "vitest";
import { personName, registrationNameLine } from "../../src/browser/person-name";

describe("personName", () => {
  it("берёт имя и фамилию как задали при создании", () => {
    expect(personName("что угодно", "Владимир", "Ленин")).toEqual({
      first: "Владимир",
      last: "Ленин",
      full: "Владимир Ленин",
    });
  });

  it("режет старое отображаемое имя по первому пробелу", () => {
    expect(personName("Владимир Ильич Ленин", null, null)).toEqual({
      first: "Владимир",
      last: "Ильич Ленин",
      full: "Владимир Ильич Ленин",
    });
  });

  it("одно слово кладёт и в имя, и в фамилию", () => {
    expect(personName("Bot", null, null)).toEqual({ first: "Bot", last: "Bot", full: "Bot" });
  });
});

describe("registrationNameLine", () => {
  it("разводит имя и фамилию по полям формы", () => {
    const line = registrationNameLine("Владимир Ленин", "Владимир", "Ленин");
    expect(line).toContain("first name — «Владимир»");
    expect(line).toContain("last name — «Ленин»");
    expect(line).toContain("«Владимир Ленин»");
    expect(line).not.toContain("одно слово");
  });
});
