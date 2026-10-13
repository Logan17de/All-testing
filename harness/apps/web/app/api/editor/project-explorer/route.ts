import {
  openProjectExplorer,
  projectExplorerAvailability,
} from "../../../../lib/project-explorer-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return projectExplorerAvailability(request);
}
export function POST(request: Request) {
  return openProjectExplorer(request);
}
