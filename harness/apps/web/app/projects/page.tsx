import Link from "next/link";

import { fetchProjects, runtimeOrigin } from "../../lib/runtime-client";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "Projects — Zet Harness" };

export default async function ProjectsPage() {
  const result = await fetchProjects();

  return (
    <main className="page">
      <nav className="crumbs">
        <Link href="/">Overview</Link>
        <span aria-hidden="true">/</span>
        <span>Projects</span>
      </nav>

      <div className="pageHeader">
        <h1 className="pageTitle">Projects</h1>
      </div>

      {!result.ok ? (
        <div className="panel">
          <p>{result.reason}</p>
          <p className="muted">
            Expected at <code>{runtimeOrigin()}</code>.
          </p>
        </div>
      ) : (
        <>
          {result.data.projects.length === 0 ? (
            <div className="panel">
              <p>No projects yet.</p>
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
                  {result.data.projects.map((project) => (
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
