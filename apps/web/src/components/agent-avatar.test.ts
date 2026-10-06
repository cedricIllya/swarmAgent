import { describe, expect, it } from "vitest";
import { AgentAvatarSchema, encodeCreatedAvatar, parseCreatedAvatar, type CreatedAvatar } from "@swarm/contracts";

const face: CreatedAvatar = {
  sex: "woman",
  faceColor: "#F9C9B6",
  earSize: "small",
  hairColor: "#000",
  hairStyle: "womanLong",
  hatColor: "#506AF4",
  hatStyle: "none",
  eyeStyle: "smile",
  eyeBrowStyle: "upWoman",
  glassesStyle: "round",
  noseStyle: "short",
  mouthStyle: "laugh",
  shirtStyle: "polo",
  shirtColor: "#FC909F",
  bgColor: "#E0DDFF",
};

describe("created avatar", () => {
  it("сохраняет конфиг и читает его обратно", () => {
    const stored = encodeCreatedAvatar(face);
    expect(parseCreatedAvatar(stored)).toEqual(face);
    expect(AgentAvatarSchema.safeParse(stored).success).toBe(true);
  });

  it("не принимает обрывок json", () => {
    expect(parseCreatedAvatar("nice:{}")).toBeNull();
    expect(AgentAvatarSchema.safeParse("nice:{}").success).toBe(false);
  });
});
