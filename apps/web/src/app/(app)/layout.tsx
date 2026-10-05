import Link from "next/link";
import type { ReactNode } from "react";
import { requireViewer } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";
import { MainNav } from "@/components/main-nav";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const viewer = await requireViewer();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden />
            Swarm
          </Link>
          <MainNav />
          <div className="topbar-right">
            <span className="viewer">
              <span className="viewer-tenant">{viewer.tenant.name}</span>
              <span className="viewer-email">{viewer.user.email}</span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="container page">{children}</main>
    </>
  );
}
