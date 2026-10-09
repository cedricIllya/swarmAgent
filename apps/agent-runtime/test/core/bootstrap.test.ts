import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
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

  it("не стирает lock, пока gateway слушает свой порт", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hermes-"));
    await writeFile(path.join(dir, "gateway.lock"), "123");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("нет порта");
    try {
      expect(await clearGatewayRecords(dir, address.port)).toEqual([]);
      expect(await readdir(dir)).toContain("gateway.lock");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
