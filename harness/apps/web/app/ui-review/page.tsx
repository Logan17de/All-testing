import { notFound } from "next/navigation";
import { SyntheticConversation } from "./synthetic-conversation";
import "../agent/coding-workspace.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Synthetic UI review - Zet Harness" };

export default function UiReviewPage() {
  if (process.env.ZET_UI_REVIEW_FIXTURES !== "1") notFound();
  return (
    <main className="page">
      <h1 className="pageTitle">Synthetic UI review</h1>
      <p className="lede">
        Sample conversation, tool output and approval request for visual review. All content is
        synthetic. No runtime requests or workspace actions are performed.
      </p>
      <SyntheticConversation />
    </main>
  );
}
