import { SettingsRoute } from "./settings-route";
import { settingsId } from "./settings-view";
import "./settings.css";
export const metadata = { title: "Settings - Zet Harness" };
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const params = await searchParams;
  return <SettingsRoute initialSection={settingsId(params.section ?? null)} />;
}
