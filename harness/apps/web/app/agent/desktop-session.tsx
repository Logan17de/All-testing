"use client";

import Image from "next/image";
import { DesktopImageConsentCard } from "./desktop-image-consent";
import {
  desktopImageConsents,
  desktopScreenshotScope,
  desktopImageScope,
} from "./desktop-image-consent-view";
import { DesktopConsentCard } from "./desktop-consent";
import { useEffect, useRef, useState } from "react";
import { workspaceRequest } from "../../lib/workspace-client";
import {
  desktopArmed,
  desktopConsents,
  desktopSessionActive,
  desktopStatus,
  monitorContains,
  type DesktopStatus,
} from "./desktop-view";

type Value = Record<string, unknown>;
type Capture = { artifactId: string; width: number; height: number; generation: number };
const object = (value: unknown): Value =>
  value && typeof value === "object" ? (value as Value) : {};

export function DesktopSession({ initialTask = "" }: { initialTask?: string }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [pendingConsents, setPendingConsents] = useState<unknown>([]);
  const [task, setTask] = useState(initialTask);
  const [monitorId, setMonitorId] = useState("");
  const [windowId, setWindowId] = useState("");
  const [armConsent, setArmConsent] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [kind, setKind] = useState("click");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [key, setKey] = useState("");
  const [typedText, setTypedText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [message, setMessage] = useState("");
  const version = useRef(0);
  const currentGeneration = useRef<number | null>(null);
  const armed = desktopSessionActive(status, receivedAt);
  const canAct = desktopArmed(status, receivedAt);

  function acceptStatus(value: unknown) {
    const next = desktopStatus(value);
    setPendingConsents(object(value).pendingConsents || []);
    if (!next) throw new Error("The desktop companion returned an unsupported status.");
    if (
      (currentGeneration.current !== null && currentGeneration.current !== next.generation) ||
      next.state !== "armed" ||
      !desktopSessionActive(next, Date.now())
    ) {
      setCapture(null);
      setTypedText("");
    }
    if (currentGeneration.current !== null && currentGeneration.current !== next.generation)
      setArmConsent(false);
    if (next.state === "armed") {
      setTask(next.task || "");
      setMonitorId(next.selection?.monitorId || "");
      setWindowId(next.selection?.windowId || "");
    }
    setReceivedAt(Date.now());
    currentGeneration.current = next.generation;
    setStatus(next);
  }

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const expected = version.current;
      const result = await workspaceRequest<unknown>("desktop");
      if (disposed) return;
      if (result.ok && expected === version.current) {
        try {
          acceptStatus(result.data);
        } catch {
          setStatus(null);
          setPollError("Desktop status is unavailable. Controls remain disabled.");
        }
      } else if (!result.ok) {
        setStatus(null);
        setPollError(result.reason);
      }
      timer = setTimeout(() => {
        void poll();
      }, 2000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  async function action(name: string, params: Value = {}) {
    const expected = currentGeneration.current;
    version.current++;
    const result = await workspaceRequest<{ result: unknown }>("desktop", { action: name, params });
    version.current++;
    if (expected !== null && currentGeneration.current !== expected)
      throw new Error("The desktop session changed. Request a new action for the current session.");
    if (!result.ok) throw new Error(result.reason);
    return result.data.result;
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Desktop request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="Desktop session">
      <h2 className="panelTitle">Desktop session</h2>
      <p role="status">
        {status
          ? `Desktop ${status.state}.`
          : "Desktop controls are disabled until a trusted local companion is available."}
      </p>
      <p className="muted">
        Desktop access starts disabled. Each session is limited to one task, a short expiry and an
        action budget. The companion asks for host consent before each input or focus action. No
        credentials or clipboard contents are read here.
      </p>
      <p className="muted">{desktopScreenshotScope(status)}</p>
      <button
        disabled={busy || !status || status.state === "disabled"}
        onClick={() => {
          void run(async () => {
            acceptStatus(await action("inventory"));
          });
        }}
      >
        Refresh monitors and windows
      </button>
      <p>
        <label>
          Task scope{" "}
          <input
            disabled={busy || armed}
            value={task}
            onChange={(event) => setTask(event.target.value)}
          />
        </label>
      </p>
      <p>
        <label>
          Monitor{" "}
          <select
            style={{ maxWidth: "100%" }}
            disabled={busy || armed}
            value={monitorId}
            onChange={(event) => {
              setMonitorId(event.target.value);
              setWindowId("");
            }}
          >
            <option value="">Choose a monitor or virtual desktop</option>
            {status?.monitors.map((monitor) => (
              <option key={monitor.id} value={monitor.id}>
                {monitor.id}: {monitor.width}×{monitor.height}, origin ({monitor.x}, {monitor.y}),
                scale {monitor.scale}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          Window{" "}
          <select
            style={{ maxWidth: "100%" }}
            disabled={busy || armed}
            value={windowId}
            onChange={(event) => setWindowId(event.target.value)}
          >
            <option value="">Entire selected monitor</option>
            {status?.windows
              .filter((window) => !window.monitorId || window.monitorId === monitorId)
              .map((window) => (
                <option key={window.id} value={window.id}>
                  {window.title}
                </option>
              ))}
          </select>
        </label>
      </p>
      <p className="muted">
        Input coordinates use physical desktop pixels, including negative monitor origins. Display
        scaling is shown above; the local preview does not change the target coordinates.
      </p>
      <label>
        <input
          type="checkbox"
          disabled={busy || armed}
          checked={armConsent}
          onChange={(event) => setArmConsent(event.target.checked)}
        />{" "}
        I authorize this local desktop session for the displayed task and selection.
      </label>{" "}
      <button
        disabled={
          busy ||
          armed ||
          !status ||
          status.state === "disabled" ||
          !armConsent ||
          !task.trim() ||
          !monitorId
        }
        onClick={() => {
          void run(async () => {
            acceptStatus(
              await action("arm", {
                task,
                monitorId,
                confirm: true,
                ...(windowId ? { windowId } : {}),
              }),
            );
          });
        }}
      >
        Arm task session
      </button>{" "}
      <button
        disabled={!armed}
        onClick={() => {
          void run(async () => {
            acceptStatus(await action("stop"));
            setCapture(null);
          });
        }}
      >
        Stop desktop session
      </button>
      {status?.state === "armed" ? (
        <p>
          Task: <code>{status.task}</code>. Expires:{" "}
          {status.expiresAt ? new Date(status.expiresAt).toLocaleString() : "Unknown"}. Actions
          remaining: {status.actionsRemaining}.
        </p>
      ) : null}
      <p>
        <button
          disabled={busy || !canAct}
          onClick={() => {
            void run(async () => {
              const result = object(await action("capture", { generation: status?.generation }));
              if (
                typeof result.artifactId !== "string" ||
                typeof result.width !== "number" ||
                typeof result.height !== "number" ||
                result.width <= 0 ||
                result.height <= 0
              )
                throw new Error("The companion returned an invalid local capture.");
              setCapture({
                artifactId: result.artifactId,
                width: result.width,
                height: result.height,
                generation: status!.generation,
              });
            });
          }}
        >
          Capture local preview
        </button>
      </p>
      {capture && armed ? (
        <div>
          <Image
            src={`/api/editor/desktop/artifacts/${encodeURIComponent(capture.artifactId)}?generation=${capture.generation}`}
            alt="Local desktop screenshot preview"
            width={capture.width}
            height={capture.height}
            unoptimized
            style={{ width: "100%", height: "auto" }}
          />
          <p className="muted">
            This preview stays between your browser and the local runtime. It is not attached to a
            model request automatically.
          </p>
          <button disabled>Manual screenshot transfer is unavailable</button>
          <p>
            To share an exact screenshot, enable desktop tools for a coding task and review its
            destination-bound screenshot request here. This page never sends the preview
            automatically.
          </p>
        </div>
      ) : null}
      <fieldset disabled={busy || !canAct}>
        <legend>Request one desktop input action</legend>
        <label>
          Action{" "}
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="move">Move pointer</option>
            <option value="click">Click</option>
            <option value="key">Press key</option>
            <option value="text">Type text</option>
            <option value="focus">Focus selected window</option>
          </select>
        </label>{" "}
        {kind === "move" || kind === "click" ? (
          <>
            <label>
              X{" "}
              <input
                type="number"
                step={1}
                value={x}
                onChange={(event) => setX(event.target.value)}
              />
            </label>{" "}
            <label>
              Y{" "}
              <input
                type="number"
                step={1}
                value={y}
                onChange={(event) => setY(event.target.value)}
              />
            </label>
          </>
        ) : kind === "key" ? (
          <label>
            Key <input value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
        ) : kind === "text" ? (
          <label>
            Text (do not enter credentials){" "}
            <input
              autoComplete="off"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
            />
          </label>
        ) : (
          <p>The selected window must be approved by the host.</p>
        )}
        <button
          onClick={() => {
            void run(async () => {
              const params: Value = { kind };
              if (kind === "move" || kind === "click") {
                const monitor = status?.monitors.find(
                  (item) => item.id === status.selection?.monitorId,
                );
                if (!x || !y || !monitorContains(monitor, Number(x), Number(y)))
                  throw new Error("Choose integer coordinates inside the selected monitor.");
                params.x = Number(x);
                params.y = Number(y);
              } else if (kind === "key") params.key = key;
              else if (kind === "text") params.text = typedText;
              else {
                if (!status?.selection?.windowId)
                  throw new Error(
                    "Select a window when arming the session before requesting focus.",
                  );
                params.windowId = status.selection.windowId;
              }
              await action("act", { generation: status?.generation, action: params });
              setTypedText("");
              setMessage(
                "One desktop action was requested. The host remains responsible for consent.",
              );
            });
          }}
        >
          Request host-approved action
        </button>
      </fieldset>
      {desktopConsents(pendingConsents, status)
        .filter((request) => request.purpose === "input")
        .map((request) => (
          <DesktopConsentCard
            key={`${request.generation}:${request.id}`}
            request={request}
            respond={async (decision) => {
              await action("approval/respond", {
                id: request.id,
                generation: request.generation,
                decision,
              });
            }}
          />
        ))}
      {desktopImageConsents(pendingConsents, status, receivedAt).map((request) => (
        <DesktopImageConsentCard
          key={`${request.generation}:${request.id}`}
          request={request}
          scope={desktopImageScope(request)}
          {...(status?.expiresAt === undefined ? {} : { taskExpiresAt: status.expiresAt })}
          respond={async (decision) => {
            await action("approval/respond", {
              id: request.id,
              generation: request.generation,
              decision,
            });
          }}
        />
      ))}
      {message ? <p role="status">{message}</p> : null}
      {pollError ? <p role="alert">{pollError}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
