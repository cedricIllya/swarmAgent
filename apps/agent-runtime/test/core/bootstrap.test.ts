import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearGatewayRecords } from "../../src/core/bootstrap";

describe("clearGatewayRecords", () => {
  it("убирает PID gateway с прошлой загрузки и не трогает остальное", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hermes-"));
    await mkdir(path.join(dir, ".local/state/hermes/gateway-locks"), { recursive: true });
    for (const f of ["gateway.lock", "gateway_state.json", ".gateway_state_5l6oz96h.tmp", "config.yaml", ".env"]) {
      await writeFile(path.join(dir, f), "{}");
    }
    await writeFile(path.join(dir, ".local/state/hermes/gateway-locks/host-gateway.lock"), "");

    const removed = await clearGatewayRecords(dir);

    expect(removed.sort()).toEqual(
      [".gateway_state_5l6oz96h.tmp", ".local/state/hermes/gateway-locks/host-gateway.lock", "gateway.lock", "gateway_state.json"].sort(),
    );
    expect((await readdir(dir)).sort()).toEqual([".env", ".local", "config.yaml"]);
  });

  it("на пустом volume ничего не делает", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hermes-"));
    expect(await clearGatewayRecords(dir)).toEqual([]);
  });
});
