import { NextResponse } from "next/server";
import { getAgent } from "@swarm/agents";
import { deleteCredential } from "@swarm/connections";
import { getViewer } from "@/lib/session";
import { db } from "@/lib/db";
import { pushServicesToAgent } from "@/lib/create-agent";

type Params = { params: Promise<{ id: string; slug: string }> };

/** Слаг рецепта: буквы, цифры и разделители, без пути. */
function decodeSlug(raw: string): string | null {
  let slug: string;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug) ? slug : null;
}

/** Снять у агента вход в сервис и отдать машине снимок уже без этого секрета. */
export async function DELETE(_req: Request, { params }: Params): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id, slug: raw } = await params;
  const slug = decodeSlug(raw);
  if (!slug) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const agent = await getAgent(db(), viewer.tenant.id, id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  await deleteCredential(db(), agent.id, slug);
  try {
    await pushServicesToAgent(agent);
  } catch (e) {
    console.warn(`[credentials] push: ${String(e)}`);
    return NextResponse.json(
      { error: "Доступ снят, но агент ещё не подтвердил. Попробуйте ещё раз." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
