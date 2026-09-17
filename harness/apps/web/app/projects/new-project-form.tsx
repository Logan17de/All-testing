"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { workspaceRequest } from "../../lib/workspace-client";
import type { ProjectView } from "../../lib/workspace-types";

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await workspaceRequest<{ readonly project: ProjectView }>("projects", {
      name,
      description,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    router.push(`/projects/${result.data.project.projectId}`);
  };

  return (
    <form
      id="new-project"
      className="panel"
      aria-label="New project"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h2 className="panelTitle">New project</h2>
      <label className="field">
        <span className="field__label">Name</span>
        <input
          className="field__input"
          value={name}
          maxLength={200}
          required
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className="field">
        <span className="field__label">Description</span>
        <textarea
          className="field__input"
          value={description}
          maxLength={4000}
          rows={3}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      {error === null ? null : (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
      <div className="btnRow">
        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy || name.trim().length === 0}
        >
          {busy ? "Creating…" : "Create project"}
        </button>
      </div>
    </form>
  );
}
