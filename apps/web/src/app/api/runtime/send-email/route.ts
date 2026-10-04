import { NextResponse } from "next/server";
import { OutboundEmailSchema } from "@swarm/contracts";
import { authenticateRuntime } from "@/lib/runtime-auth";
import { sendAsAgent } from "@/lib/mailer";

/** Runtime просит отправить письмо с адреса агента. */
export async function POST(req: Request): Promise<Response> {
  const agent = await authenticateRuntime(req);
  if (!agent) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = OutboundEmailSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad input" }, { status: 400 });
  try {
    return NextResponse.json(await sendAsAgent(agent, parsed.data));
  } catch (e) {
    return NextResponse.json({ error: String(e instanceof Error ? e.message : e) }, { status: 502 });
  }
}
