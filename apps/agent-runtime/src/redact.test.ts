import { describe, expect, it } from "vitest";
import { redactInternal } from "./redact";

describe("redactInternal", () => {
  it("drops local urls, disk paths, tokens and key names", () => {
    const text = [
      "Вошёл в Linear, вижу 3 задачи.",
      "Вызвал http://127.0.0.1:8787/browser/open с Authorization: Bearer $SWARM_RUNTIME_TOKEN.",
      "Ключ лежит в /opt/data/.env, API_SERVER_KEY=secret, хост http://agt.internal:8787 и http://swarm.flycast:8787.",
    ].join("\n");
    const out = redactInternal(text);
    expect(out).toContain("Вошёл в Linear");
    expect(out).not.toMatch(/127\.0\.0\.1|internal|flycast|\/opt\/data|SWARM_RUNTIME_TOKEN|API_SERVER_KEY|Bearer/i);
  });

  it("keeps an ordinary answer", () => {
    expect(redactInternal("Создал задачу «Отчёт» в Linear.")).toBe("Создал задачу «Отчёт» в Linear.");
  });

  it("replaces a reply that was only internals", () => {
    expect(redactInternal("http://127.0.0.1:8787/state")).toBe("Готово. Внутренние подробности работы не показываю.");
  });
});
