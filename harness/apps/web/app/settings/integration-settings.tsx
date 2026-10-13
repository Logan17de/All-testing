"use client";

import { useEffect, useState } from "react";
import { AssistantWorkspace } from "../assistant/assistant-workspace";
import { InstallPlugin } from "../plugins/install-plugin";
import type { PluginReport } from "../../lib/runtime-client";
import { workspaceRequest, type WorkspaceResult } from "../../lib/workspace-client";
import { reasonOf } from "../../lib/workspace-types";
import "./integration-settings.css";

function useReport<T>(read: () => Promise<WorkspaceResult<T>>) {
  const [result, setResult] = useState<WorkspaceResult<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    void read()
      .then((value) => {
        if (!current) return;
        setResult(value);
        setLoading(false);
      })
      .catch(() => {
        if (!current) return;
        setResult({ ok: false, reason: "The runtime daemon is not reachable." });
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [read, revision]);
  return {
    result,
    loading,
    refresh: () => {
      setLoading(true);
      setRevision((value) => value + 1);
    },
  };
}

function ReportStatus({
  loading,
  error,
  refresh,
}: {
  loading: boolean;
  error: string | undefined;
  refresh: () => void;
}) {
  return (
    <div className="integrationStatus">
      <p role={error ? "alert" : "status"}>
        {loading ? "Loading runtime status…" : error || "Status from the current runtime."}
      </p>
      <button type="button" onClick={refresh} disabled={loading}>
        {error ? "Retry" : "Refresh"}
      </button>
    </div>
  );
}

async function readPlugins(): Promise<WorkspaceResult<PluginReport>> {
  const response = await fetch("/api/editor/plugins", { cache: "no-store" });
  const payload = (await response.json()) as unknown;
  if (!response.ok)
    return { ok: false, reason: reasonOf(payload, "Plugin status is unavailable.") };
  const report = payload as PluginReport;
  if (
    !Array.isArray(report.installed) ||
    !Array.isArray(report.failures) ||
    !Array.isArray(report.configDefects) ||
    !Array.isArray(report.isolated) ||
    !Array.isArray(report.activated) ||
    typeof report.directory !== "string"
  ) {
    return { ok: false, reason: "Plugin status returned an unsupported report." };
  }
  return { ok: true, data: report };
}

export function PluginSettings() {
  const { result, loading, refresh } = useReport(readPlugins);
  const report = result?.ok ? result.data : null;
  return (
    <div className="integrationSettings">
      <ReportStatus
        loading={loading}
        error={result && !result.ok ? result.reason : undefined}
        refresh={refresh}
      />
      {report ? (
        <>
          {!report.installed.length ? (
            <p className="integrationEmpty">No plugins are installed.</p>
          ) : (
            report.installed.map((plugin) => (
              <section className="integrationCard" key={plugin.id}>
                <div className="integrationHeading">
                  <strong>{plugin.name}</strong>
                  <span className="integrationBadge">
                    {plugin.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <p className="integrationMuted">
                  {plugin.id} · {plugin.version}
                  {plugin.enabled
                    ? ` · ${report.isolated.includes(plugin.id) ? "Isolated" : "In-process"}`
                    : ""}
                  {report.activated.includes(plugin.id) ? " · Active" : ""}
                </p>
                <dl className="integrationDetails">
                  <div>
                    <dt>Nodes</dt>
                    <dd>{plugin.declaredNodes.join(", ") || "None"}</dd>
                  </div>
                  <div>
                    <dt>Requested</dt>
                    <dd>{plugin.requestedCapabilities.join(", ") || "None"}</dd>
                  </div>
                  <div>
                    <dt>Granted</dt>
                    <dd>{plugin.grantedCapabilities.join(", ") || "None"}</dd>
                  </div>
                  <div>
                    <dt>Withheld</dt>
                    <dd>{plugin.withheldCapabilities.join(", ") || "None"}</dd>
                  </div>
                </dl>
                {plugin.unsigned ? (
                  <p className="integrationMuted">Package integrity is unsigned.</p>
                ) : null}
              </section>
            ))
          )}
          {report.configDefects.length ? (
            <section className="integrationCard">
              <strong>Configuration issues</strong>
              <ul>
                {report.configDefects.map((defect, index) => (
                  <li key={index}>{defect}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {report.failures.length ? (
            <section className="integrationCard">
              <strong>Packages that did not load</strong>
              <ul>
                {report.failures.map((failure, index) => (
                  <li key={index}>
                    {failure.packageName}: {failure.message} ({failure.code})
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {report.install?.npm === true || report.install?.git === true ? (
            <InstallPlugin
              npm={report.install.npm}
              git={report.install.git}
              directory={report.directory}
            />
          ) : (
            <p className="integrationMuted">Plugin installation is disabled in this runtime.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

type BrowserMetadata = {
  armed?: boolean;
  remainingActions?: number;
  captureSharing?: string;
  failureCode?: string | null;
  failureStage?: string | null;
  capabilities?: Partial<
    Record<
      | "browserWindow"
      | "desktop"
      | "persistentProfiles"
      | "sharing"
      | "osNetworkFirewall"
      | "mutationRequests",
      boolean
    >
  >;
};
const browserCapabilities = [
  ["browserWindow", "Browser window"],
  ["desktop", "Desktop access"],
  ["persistentProfiles", "Persistent profiles"],
  ["sharing", "Capture sharing"],
  ["osNetworkFirewall", "OS network firewall"],
  ["mutationRequests", "Mutation requests"],
] as const;
const capabilityStatus = (value: unknown) =>
  typeof value === "boolean" ? (value ? "Supported" : "Unsupported") : "Not reported";

function readBrowser() {
  return workspaceRequest<BrowserMetadata>("browser");
}

export function BrowserSettings() {
  const { result, loading, refresh } = useReport(readBrowser);
  const metadata =
    result?.ok && result.data && typeof result.data === "object" ? result.data : null;
  return (
    <div className="integrationSettings">
      <ReportStatus
        loading={loading}
        error={result && !result.ok ? result.reason : undefined}
        refresh={refresh}
      />
      {metadata ? (
        <>
          <dl className="integrationDetails">
            <div>
              <dt>Session</dt>
              <dd>
                {typeof metadata.armed === "boolean"
                  ? metadata.armed
                    ? "Armed"
                    : "Idle"
                  : "Not reported"}
              </dd>
            </div>
            {typeof metadata.remainingActions === "number" ? (
              <div>
                <dt>Remaining actions</dt>
                <dd>{metadata.remainingActions}</dd>
              </div>
            ) : null}
            {browserCapabilities.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>{capabilityStatus(metadata.capabilities?.[key])}</dd>
              </div>
            ))}
            {typeof metadata.failureStage === "string" ? (
              <div>
                <dt>Failure stage</dt>
                <dd>{metadata.failureStage}</dd>
              </div>
            ) : null}
            {typeof metadata.failureCode === "string" ? (
              <div>
                <dt>Failure code</dt>
                <dd>{metadata.failureCode}</dd>
              </div>
            ) : null}
          </dl>
          <p className="integrationMuted">
            Capabilities are reported by the runtime. Browser worker launch has not been tested
            here.
          </p>
          <p className="integrationMuted">
            Browser sessions require a bounded task and explicit authorization in the browser
            workspace.
          </p>
        </>
      ) : null}
    </div>
  );
}

export function ConnectionSettings() {
  return (
    <div className="integrationSettings integrationConnections">
      <p className="integrationMuted">
        Choose a saved assistant to review and manage its authorized chat connections.
      </p>
      <AssistantWorkspace />
    </div>
  );
}
