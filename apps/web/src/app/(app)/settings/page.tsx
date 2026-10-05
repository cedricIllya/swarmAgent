import { requireViewer } from "@/lib/session";
import { previewAccountDeletion } from "@/lib/delete-account";
import { AccountSettings } from "@/components/account-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const viewer = await requireViewer();
  const preview = await previewAccountDeletion(viewer.user.id);
  return <AccountSettings viewer={viewer} preview={preview} />;
}
