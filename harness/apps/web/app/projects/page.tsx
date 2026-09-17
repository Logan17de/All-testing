import Link from "next/link";

import { fetchProjects, fetchSetup, runtimeOrigin } from "../../lib/runtime-client";
import { inWorkspace } from "../../lib/workspaces";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Projects — Zet Harness" };

export default async function ProjectsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [result, setup, params] = await Promise.all([fetchProjects(), fetchSetup(), searchParams]);
  const workspace = setup.ok ? (setup.data.setup.workspace?.path ?? null) : null;
  // A project belongs to the folder it was made in; `all` looks past that.
  const everywhere = params["all"] === "1";
  const all = result.ok ? result.data.projects : [];
  const projects =
    everywhere || workspace === null
      ? all
      : all.filter((project) => inWorkspace(project.workspacePath ?? null, workspace));
  const elsewhere = all.length - projects.length;

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Projects</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Projects</h1>
        <Link className="btn" href="#new-project">
          New project
        </Link>
      </div>

      {workspace === null ? null : (
        <p className="muted small">
          {everywhere ? (
            <>
              Every project, from all folders. <Link href="/projects">Only this folder</Link>
            </>
          ) : (
            <>
              In <code>{workspace}</code>
              {elsewhere > 0 ? (
                <>
                  {" · "}
                  <Link href="/projects?all=1">
                    {elsewhere} in other {elsewhere === 1 ? "folder" : "folders"}
                  </Link>
                </>
              ) : null}
            </>
          )}
        </p>
      )}

      {!result.ok ? (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>.
          </p>
        </div>
      ) : (
        <>
          {projects.length === 0 ? (
            <div className="panel">
              <p>{all.length === 0 ? "No projects yet." : "No projects in this folder yet."}</p>
              <p className="muted">
                A project holds conversations, goals and todos, and the agent runs that work on
                them.
              </p>
            </div>
          ) : (
            <div className="tableWrap">
              <table className="runTable">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Status</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr key={project.projectId}>
                      <td>
                        <Link href={`/projects/${project.projectId}`}>{project.name}</Link>
                        {project.description.length > 0 ? (
                          <div className="muted small">{project.description}</div>
                        ) : null}
                      </td>
                      <td>
                        <span className="chip">{project.status}</span>
                      </td>
                      <td>{new Date(project.updatedAtMs).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <NewProjectForm />
        </>
      )}
    </main>
  );
}
