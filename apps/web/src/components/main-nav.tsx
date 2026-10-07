"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { t, type MessageKey } from "@/i18n";

const ITEMS: { href: string; label: MessageKey; match: (p: string) => boolean }[] = [
  { href: "/", label: "nav.agents", match: (p) => p === "/" || p.startsWith("/agents") },
  { href: "/services", label: "nav.services", match: (p) => p.startsWith("/services") },
  { href: "/settings", label: "nav.settings", match: (p) => p.startsWith("/settings") },
];

export function MainNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav" aria-label={t("nav.label")}>
      {ITEMS.map((item) => (
        <Link key={item.href} href={item.href} className={`nav-link${item.match(pathname) ? " active" : ""}`}>
          {t(item.label)}
        </Link>
      ))}
    </nav>
  );
}
