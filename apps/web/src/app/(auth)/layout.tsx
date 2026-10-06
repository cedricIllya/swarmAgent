import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      {children}
    </>
  );
}
