import { AgentWorkspace } from "./agent-workspace";

export const metadata = { title: "Coding workspace — Zet Harness" };

export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  const query = await searchParams;
  return (
    <main className="codingPage">
      <AgentWorkspace initialSessionId={typeof query.session === "string" ? query.session : ""} />
    </main>
  );
}
