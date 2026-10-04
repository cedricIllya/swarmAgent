import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveActiveTenant, type TenantView } from "@swarm/identity";
import { auth } from "./auth";
import { db } from "./db";

export interface Viewer {
  user: { id: string; email: string; name: string };
  tenant: TenantView;
}

/** Текущий пользователь и его активный тенант. Для route handlers. */
export async function getViewer(): Promise<Viewer | null> {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const active = (session.session as { activeTenantId?: string | null }).activeTenantId ?? null;
  const tenant = await resolveActiveTenant(db(), session.user.id, active);
  if (!tenant) return null;
  return {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
    tenant,
  };
}

/** Для страниц: без входа — на /login. */
export async function requireViewer(): Promise<Viewer> {
  const v = await getViewer();
  if (!v) redirect("/login");
  return v;
}
