import { after, NextResponse } from "next/server";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { suspendAgent } from "@/lib/fly-machines";

/**
 * Runtime решил, что работы нет. Отвечаем сразу, усыпляем после:
 * иначе suspend заморозит машину раньше, чем она получит ответ.
 */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  after(async () => {
    try {
      const result = await suspendAgent(agent);
      console.log(`[sleep] ${agent.id} ${result}`);
    } catch (e) {
      console.warn(`[sleep] ${agent.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return NextResponse.json({ ok: true });
}
