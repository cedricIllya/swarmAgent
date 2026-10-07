"use client";

import { useRouter } from "next/navigation";
import { t } from "@/i18n";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="btn btn-sm"
      onClick={async () => {
        await authClient.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      {t("auth.signOut")}
    </button>
  );
}
