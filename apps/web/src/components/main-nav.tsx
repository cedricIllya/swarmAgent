"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Агенты", match: (p: string) => p === "/" || p.startsWith("/agents") },
  { href: "/services", label: "Сервисы", match: (p: string) => p.startsWith("/services") },
] as const;

export function MainNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav" aria-label="Основная навигация">
      {ITEMS.map((item) => (
        <Link key={item.href} href={item.href} className={`nav-link${item.match(pathname) ? " active" : ""}`}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
