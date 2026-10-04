import Link from "next/link";
import type { ReactNode } from "react";
import { requireViewer } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">
            <span className="brand-dot" />
            Swarm Agent
          </Link>
          <div className="row">
            <span className="muted small">
              {viewer.tenant.name} · {viewer.user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="container" style={{ paddingTop: 28 }}>
        {children}
      </main>
    </>
  );
}
