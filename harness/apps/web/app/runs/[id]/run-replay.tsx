"use client";

import {
  describeReplayStep,
  type ReplayStepView,
  type RunReplayView,
} from "../../../lib/replay-view";

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function detailOf(step: ReplayStepView): string | null {
  if (step.detail === null || step.detail === undefined) return null;
  const text = pretty(step.detail);
  return text === "{}" ? null : text;
}

/**
 * A run, read back one step at a time.
 *
 * Nothing runs here: the runtime replays the run's own journal and attempt records,
 * so every step shown is what happened, not what would happen now. Walking forward
 * also walks the canvas: each node takes the state it had at that point, so the graph
 * fills in in the order the run filled it in.
 */
export function ReplayPanel({
  replay,
  index,
  startedAt,
  onIndex,
  onClose,
}: {
  readonly replay: RunReplayView;
  readonly index: number;
  readonly startedAt: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
}) {
  const steps = replay.steps;
  const current = steps[index];
  const detail = current === undefined ? null : detailOf(current);

  return (
    <>
      <div className="btnRow">
        <button type="button" className="btn" onClick={onClose}>
          ← Back to the timeline
        </button>
      </div>
      <h2 className="panelTitle">Replay</h2>
      <p className="muted small">
        The run&apos;s own journal, read back. Nothing is called and nothing is written.
      </p>

      {replay.consistent ? null : (
        <div className="replayIssues" role="alert">
          <p className="warn">The journal and the stored records do not agree.</p>
          <ul className="forkList">
            {replay.issues.map((issue) => (
              <li key={`${issue.code}-${String(issue.eventId)}`}>
                <span className="chip">{issue.code}</span>{" "}
                <span className="small">{issue.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {steps.length === 0 || current === undefined ? (
        <p className="muted small">This run recorded nothing to replay.</p>
      ) : (
        <>
          <div className="btnRow">
            <button
              type="button"
              className="btn"
              disabled={index === 0}
              onClick={() => {
                onIndex(0);
              }}
            >
              ⏮ Start
            </button>
            <button
              type="button"
              className="btn"
              disabled={index === 0}
              onClick={() => {
                onIndex(index - 1);
              }}
            >
              ← Previous
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={index >= steps.length - 1}
              onClick={() => {
                onIndex(index + 1);
              }}
            >
              Next →
            </button>
            <button
              type="button"
              className="btn"
              disabled={index >= steps.length - 1}
              onClick={() => {
                onIndex(steps.length - 1);
              }}
            >
              End ⏭
            </button>
          </div>

          <p className="statusLine">
            Step {String(index + 1)} of {String(steps.length)}
            <span className="chip">{current.kind}</span>
            <span className="muted small">+{String(current.occurredAtMs - startedAt)}ms</span>
          </p>
          <p>{describeReplayStep(current)}</p>
          {current.iteration === null || current.iteration === 0 ? null : (
            <p className="muted small">Iteration {String(current.iteration + 1)} of its loop.</p>
          )}
          {detail === null ? (
            <p className="muted small">This step recorded no values.</p>
          ) : (
            <pre className="codeBlock">{detail}</pre>
          )}

          <h3 className="sectionTitle">Every step</h3>
          <ol className="timeline">
            {steps.map((step, position) => (
              <li key={step.sequence}>
                <button
                  type="button"
                  className={`timeline__row${position === index ? " timeline__row--current" : ""}`}
                  onClick={() => {
                    onIndex(position);
                  }}
                >
                  <span className="timeline__time">+{String(step.occurredAtMs - startedAt)}ms</span>
                  <span className="timeline__type">{describeReplayStep(step)}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
