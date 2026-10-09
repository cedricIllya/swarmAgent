import { describe, expect, it } from "vitest";
import {
  AGENT_PORT_MIN,
  AGENT_PORT_SPAN,
  allocateExternalPort,
  buildAgentMachineConfig,
  externalPortFromUrl,
  externalPortsFromConfig,
  machineNameFor,
  runtimeUrlFor,
  volumeNameFor,
} from "./machine";

const agentId = "agt_3n2s0d6g5h4e46720v6x";

describe("volumeNameFor", () => {
  it("берёт id агента, чтобы в общем приложении диск не нашёлся чужой", () => {
    expect(volumeNameFor(agentId)).toBe(agentId);
    expect(volumeNameFor(agentId).length).toBeLessThanOrEqual(30);
  });
});

describe("allocateExternalPort", () => {
  it("для одного id стабилен и обходит уже занятый порт", () => {
    const first = allocateExternalPort(agentId, []);
    expect(allocateExternalPort(agentId, [])).toBe(first);
    expect(first).toBeGreaterThanOrEqual(AGENT_PORT_MIN);
    expect(first).toBeLessThan(AGENT_PORT_MIN + AGENT_PORT_SPAN);
    expect(allocateExternalPort(agentId, [first])).not.toBe(first);
  });

  it("двум агентам не выдаёт один порт, пока диапазон не кончился", () => {
    const a = allocateExternalPort("agt_aaaaaaaaaaaaaaaaaaaa", []);
    const b = allocateExternalPort("agt_bbbbbbbbbbbbbbbbbbbb", [a]);
    expect(b).not.toBe(a);
  });
});

describe("runtimeUrlFor", () => {
  it("кладёт порт в адрес, по которому прокси будит эту машину", () => {
    const url = runtimeUrlFor("swarm-agents", 23456);
    expect(url).toBe("http://swarm-agents.flycast:23456");
    expect(externalPortFromUrl(url)).toBe(23456);
    expect(externalPortFromUrl("http://old.internal:8787")).toBe(8787);
    expect(externalPortFromUrl("не адрес")).toBeNull();
  });
});

describe("buildAgentMachineConfig", () => {
  it("публикует свой внешний порт и монтирует диск по его имени", () => {
    const config = buildAgentMachineConfig({
      volumeId: "vol_1",
      volumeName: agentId,
      externalPort: 23456,
      hermesImage: "hermes",
      runtimeImage: "runtime",
      env: { AGENT_ID: agentId },
      files: [],
    });
    expect(config.mounts).toEqual([{ volume: "vol_1", path: "/opt/data", name: agentId }]);
    expect(externalPortsFromConfig(config)).toEqual([23456]);
    expect(config.services?.[0]?.internal_port).toBe(8787);
    expect(machineNameFor(agentId)).toBe("agt-3n2s0d6g5h4e46720v6x");
  });
});
