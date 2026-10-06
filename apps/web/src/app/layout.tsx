import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ConfirmProvider } from "@/components/confirm-dialog";
import { ThemeWatcher } from "@/components/theme-toggle";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarm Agent",
  description: "Агенты с собственной почтой",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {/* Сборщик оставляет только -webkit-backdrop-filter, а текущий Chrome его уже не читает. */}
        <style href="glass-blur" precedence="default">{`
          .scroll-edge { backdrop-filter: blur(16px) saturate(160%); }
          .topbar, .btn { backdrop-filter: blur(40px) saturate(180%); }
          .modal { backdrop-filter: blur(48px) saturate(180%); }
          .btn-ghost, .topbar .btn, .modal .btn { backdrop-filter: none; }
          @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
            .scroll-edge, .topbar, .btn, .modal { backdrop-filter: none; }
          }
        `}</style>
        <ThemeWatcher />
        <div className="scroll-edge" aria-hidden="true" />
        <ConfirmProvider>{children}</ConfirmProvider>
      </body>
    </html>
  );
}
