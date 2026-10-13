"use client";

import { useEffect, useState } from "react";
import { isModelView, type ModelView } from "../../lib/model-form";
import { reasonOf } from "../../lib/workspace-types";
import { ChatGPTConnection } from "../agent/chatgpt-connection";
import { ModelsWorkspace } from "../models/models-workspace";
import "./model-settings.css";

type ModelState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "ready"; readonly models: readonly ModelView[] };

export function ModelSettings() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ModelState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/editor/models", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setState({ status: "error", reason: reasonOf(payload, "Models could not be loaded.") });
          return;
        }
        const models =
          typeof payload === "object" && payload !== null && "models" in payload
            ? payload.models
            : undefined;
        if (!Array.isArray(models) || !models.every(isModelView)) {
          setState({ status: "error", reason: "The model list returned an invalid response." });
          return;
        }
        setState({ status: "ready", models });
      } catch {
        if (!cancelled) {
          setState({ status: "error", reason: "Models could not be loaded. Try again." });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt]);

  return (
    <div
      className="settingsModelPanel"
      aria-label="Model settings"
      aria-busy={state.status === "loading"}
    >
      {state.status === "loading" ? (
        <p className="settingsModelStatus" role="status">
          Loading models…
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="settingsModelNotice">
          <p role="alert">{state.reason}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((current) => current + 1);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <ModelsWorkspace initialModels={state.models} startWith={null} />
      ) : null}
    </div>
  );
}

export function AccountSettings() {
  return (
    <div className="settingsModelPanel settingsAccountPanel">
      <ChatGPTConnection />
    </div>
  );
}
