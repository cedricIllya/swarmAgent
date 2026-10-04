import { NextResponse } from "next/server";
import { getViewer } from "@/lib/session";
import { listModels } from "@/lib/models";

export async function GET(): Promise<Response> {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ models: await listModels() });
  } catch (e) {
    return NextResponse.json({ models: [], error: String(e) });
  }
}
