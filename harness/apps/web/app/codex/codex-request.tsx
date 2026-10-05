"use client";
import { useState } from "react";
import { formFields, formContent } from "./codex-form-view";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" ? (value as ObjectValue) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

type Props = {
  request: { id: string | number; method: string; params: unknown };
  disabled: boolean;
  respond: (action: string, params: ObjectValue) => Promise<void>;
};

function ElicitationRequest({ request, disabled, respond }: Props) {
  const params = object(request.params);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string | string[]>>({});
  const [error, setError] = useState("");
  const [externalConsent, setExternalConsent] = useState(false);
  const [externalOpened, setExternalOpened] = useState(false);
  const userInput = request.method === "item/tool/requestUserInput";
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(object);
  const schema = object(params.requestedSchema);
  const form = formFields(schema);
  const url = text(params.url);
  let safeUrl = "";
  try {
    const target = new URL(url);
    if (target.protocol === "https:" && !target.username && !target.password) safeUrl = target.href;
  } catch {
    /* no link for invalid URL */
  }
  const formSupported = !url && form.supported;
  async function submit() {
    setError("");
    if (userInput) {
      const result: ObjectValue = {};
      for (const question of questions) {
        const id = text(question.id);
        if (!id || !answers[id]?.trim()) {
          setError("Answer every question before submitting.");
          return;
        }
        result[id] = { answers: [answers[id]] };
      }
      await respond("user-input/respond", { id: request.id, answers: result });
    } else if (safeUrl) {
      if (!externalConsent || !externalOpened) return;
      await respond("elicitation/respond", {
        id: request.id,
        action: "accept",
        content: null,
        confirmExternalConsent: true,
      });
    } else {
      const result = formContent(form.fields, values, schema);
      if (!result.content) {
        setError(result.error || "Invalid answers.");
        return;
      }
      const content = result.content;
      await respond("elicitation/respond", { id: request.id, action: "accept", content });
    }
  }
  return (
    <div>
      <p>
        {text(params.message) ||
          (userInput
            ? "Codex needs your answers to continue."
            : "An MCP server requests information.")}
      </p>
      {userInput ? (
        questions.map((question) => (
          <fieldset key={text(question.id)} disabled={disabled}>
            <legend>{text(question.header) || text(question.id)}</legend>
            <p>{text(question.question)}</p>
            {Array.isArray(question.options)
              ? question.options.map((raw) => {
                  const option = object(raw);
                  const label = text(option.label);
                  return (
                    <label key={label} style={{ display: "block" }}>
                      <input
                        type="radio"
                        name={`codex-${String(request.id)}-${text(question.id)}`}
                        checked={answers[text(question.id)] === label}
                        onChange={() =>
                          setAnswers((previous) => ({ ...previous, [text(question.id)]: label }))
                        }
                      />{" "}
                      {label} {text(option.description)}
                    </label>
                  );
                })
              : null}
            <label>
              Answer{" "}
              <input
                type={question.isSecret === true ? "password" : "text"}
                autoComplete="off"
                value={answers[text(question.id)] || ""}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [text(question.id)]: event.target.value,
                  }))
                }
              />
            </label>
          </fieldset>
        ))
      ) : formSupported ? (
        <>
          <p>Do not enter API keys, passwords or other secrets in this form.</p>
          {form.fields.map((field) => {
            const enumeration =
              field.options ||
              (field.type === "boolean"
                ? [
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]
                : null);
            const numeric = field.type === "number" || field.type === "integer";
            const format = text(field.schema.format);
            return (
              <p key={field.name}>
                <label>
                  {field.title}
                  {field.required ? " (required)" : ""}{" "}
                  {enumeration ? (
                    <select
                      multiple={field.type === "array"}
                      disabled={disabled}
                      value={values[field.name] || (field.type === "array" ? [] : "")}
                      onChange={(event) =>
                        setValues((previous) => ({
                          ...previous,
                          [field.name]:
                            field.type === "array"
                              ? Array.from(event.target.selectedOptions, (option) => option.value)
                              : event.target.value,
                        }))
                      }
                    >
                      {field.type !== "array" ? <option value="">Choose</option> : null}
                      {enumeration.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      disabled={disabled}
                      autoComplete="off"
                      type={
                        numeric
                          ? "number"
                          : format === "email"
                            ? "email"
                            : format === "uri"
                              ? "url"
                              : "text"
                      }
                      step={field.type === "integer" ? 1 : "any"}
                      min={
                        typeof field.schema.minimum === "number" ? field.schema.minimum : undefined
                      }
                      max={
                        typeof field.schema.maximum === "number" ? field.schema.maximum : undefined
                      }
                      minLength={
                        typeof field.schema.minLength === "number"
                          ? field.schema.minLength
                          : undefined
                      }
                      maxLength={
                        typeof field.schema.maxLength === "number"
                          ? field.schema.maxLength
                          : undefined
                      }
                      value={typeof values[field.name] === "string" ? values[field.name] : ""}
                      onChange={(event) =>
                        setValues((previous) => ({ ...previous, [field.name]: event.target.value }))
                      }
                    />
                  )}
                </label>
                {field.description ? <small> {field.description}</small> : null}
                {field.type === "array" ? (
                  <small>
                    {" "}
                    Select multiple values with Ctrl or Command.{" "}
                    {typeof field.schema.minItems === "number"
                      ? `Minimum ${field.schema.minItems}. `
                      : ""}
                    {typeof field.schema.maxItems === "number"
                      ? `Maximum ${field.schema.maxItems}.`
                      : ""}
                  </small>
                ) : null}
              </p>
            );
          })}
        </>
      ) : (
        <p>
          {safeUrl
            ? "This MCP server requests an external interaction."
            : "This form is unsupported and cannot be accepted here."}
          {safeUrl ? (
            <>
              {" "}
              <span>
                Target: <code>{new URL(safeUrl).hostname}</code>.{" "}
              </span>
              <label style={{ display: "block" }}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={externalConsent}
                  onChange={(event) => {
                    setExternalConsent(event.target.checked);
                    if (!event.target.checked) setExternalOpened(false);
                  }}
                />{" "}
                I consent to this external interaction.
              </label>
              <a
                href={externalConsent ? safeUrl : undefined}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!externalConsent}
                onClick={(event) => {
                  if (!externalConsent) {
                    event.preventDefault();
                    setError("Confirm consent before opening the external request.");
                    return;
                  }
                  setExternalOpened(true);
                  setError("");
                }}
              >
                Open the external request after confirming consent
              </a>
              . Opening it does not accept this request.
              <small>
                Your response records consent only. The MCP server verifies completion; this page
                does not verify authentication.
              </small>
            </>
          ) : null}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <button
        disabled={
          disabled ||
          (!userInput && !formSupported && !(safeUrl && externalConsent && externalOpened)) ||
          (userInput && questions.length === 0)
        }
        onClick={() => {
          void submit();
        }}
      >
        {safeUrl ? "Confirm external consent" : "Submit answers"}
      </button>
      {!userInput ? (
        <>
          {" "}
          <button
            disabled={disabled}
            onClick={() => {
              void respond("elicitation/respond", {
                id: request.id,
                action: "decline",
                content: null,
              });
            }}
          >
            Decline
          </button>{" "}
          <button
            disabled={disabled}
            onClick={() => {
              void respond("elicitation/respond", {
                id: request.id,
                action: "cancel",
                content: null,
              });
            }}
          >
            Cancel request
          </button>
        </>
      ) : null}
    </div>
  );
}

function NativeConsent({ request, disabled, respond }: Props) {
  const [consent, setConsent] = useState(false);
  const dynamicTool = request.method === "item/tool/call";
  const params = object(request.params);
  return (
    <div>
      <p>
        {dynamicTool
          ? "Codex requests one invocation of a fixed read-only workspace tool."
          : "Codex requests additional filesystem permissions for this turn only."}
      </p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(
          dynamicTool ? { tool: params.tool, arguments: params.arguments } : params.permissions,
          null,
          2,
        )}
      </pre>
      <p>
        {dynamicTool
          ? "The runtime accepts only its fixed directory-list and file-read tools. Your click authorizes this invocation once."
          : "The runtime accepts only existing regular-file permissions inside this workspace for this turn. Directory, network, outside-workspace and persistent grants are refused."}
      </p>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />{" "}
        {dynamicTool
          ? "I authorize this one read-only tool invocation."
          : "I consent to the displayed workspace filesystem permissions for this turn."}
      </label>{" "}
      <button
        disabled={disabled || !consent}
        onClick={() => {
          void respond(
            dynamicTool ? "dynamic-tool/respond" : "permissions/respond",
            dynamicTool
              ? { id: request.id, execute: true }
              : { id: request.id, decision: "allow", confirmTurnPermission: true },
          );
        }}
      >
        {dynamicTool ? "Execute once" : "Allow for this turn"}
      </button>{" "}
      <button
        disabled={disabled}
        onClick={() => {
          void respond(
            dynamicTool ? "dynamic-tool/respond" : "permissions/respond",
            dynamicTool ? { id: request.id, execute: false } : { id: request.id, decision: "deny" },
          );
        }}
      >
        Deny
      </button>
    </div>
  );
}

export function CodexRequest(props: Props) {
  return props.request.method === "item/tool/call" ||
    props.request.method === "item/permissions/requestApproval" ? (
    <NativeConsent {...props} />
  ) : (
    <ElicitationRequest {...props} />
  );
}
