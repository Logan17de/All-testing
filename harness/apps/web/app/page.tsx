import { redirect } from "next/navigation";
import { fetchSetup } from "../lib/runtime-client";
export const dynamic = "force-dynamic";
export default async function HomePage() {
  const setup = await fetchSetup();
  if (setup.ok && !setup.data.setup.complete) redirect("/setup");
  redirect("/agent");
}
