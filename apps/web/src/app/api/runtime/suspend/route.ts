import { after, NextResponse } from "next/server";
import { SuspendRequestSchema } from "@swarm/contracts";
import { rememberAgentUsage } from "@swarm/agents";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { machineHeld, suspendAgent } from "@/lib/fly-machines";
import { RuntimeClient } from "@/lib/runtime-client";
import { db } from "@/lib/db";

/**
 * Runtime решил, что работы нет. Отвечаем сразу, усыпляем после:
 * иначе suspend заморозит машину раньше, чем она получит ответ.
 * Итоги usage из тела запоминаем в базе: во сне их больше негде взять.
 */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = SuspendRequestSchema.safeParse(await req.json().catch(() => ({})));
  const usage = parsed.success ? parsed.data.usage : undefined;
  after(async () => {
    if (usage) {
      await rememberAgentUsage(db(), agent.id, usage).catch((e) =>
        console.warn(`[sleep] ${agent.id} usage: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    try {
      if (machineHeld(agent.id)) {
        console.log(`[sleep] ${agent.id} skipped`);
        return;
      }
      const client = RuntimeClient.for(agent);
      if (client) {
        try {
          const { idle } = await client.idle();
          if (!idle) {
            console.log(`[sleep] ${agent.id} skipped`);
            return;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // Старый runtime этой проверки не знает. Срок и pin уже решили, можно ли спать.
          if (!message.includes("→ 404")) {
            console.warn(`[sleep] ${agent.id} не проверил простой: ${message}`);
            return;
          }
        }
      }
      const result = await suspendAgent(agent);
      console.log(`[sleep] ${agent.id} ${result}`);
    } catch (e) {
      console.warn(`[sleep] ${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return NextResponse.json({ ok: true });
}
