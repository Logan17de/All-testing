"use client";
import { useState } from "react";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" ? (value as ObjectValue) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

type Props = {
  request: { id: string | number; method: string; params: unknown };
  disabled: boolean;
  respond: (action: string, params: ObjectValue) => Promise<void>;
};

export function CodexRequest({ request, disabled, respond }: Props) {
  const params = object(request.params);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [externalConsent, setExternalConsent] = useState(false);
  const [externalOpened, setExternalOpened] = useState(false);
  const userInput = request.method === "item/tool/requestUserInput";
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(object);
  const schema = object(params.requestedSchema);
  const properties = object(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  const url = text(params.url);
  let safeUrl = "";
  try {
    const target = new URL(url);
    if (target.protocol === "https:" && !target.username && !target.password) safeUrl = target.href;
  } catch {
    /* no link for invalid URL */
  }
  const formSupported =
    !url &&
    schema.type === "object" &&
    Object.values(properties).every((property) =>
      ["string", "number", "integer", "boolean"].includes(text(object(property).type)),
    );
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
      const content: ObjectValue = {};
      for (const [name, raw] of Object.entries(properties)) {
        const property = object(raw);
        const value = values[name];
        if (value === undefined || value === "") {
          if (required.includes(name)) {
            setError(`Provide ${name}.`);
            return;
          }
          continue;
        }
        if (property.type === "boolean") content[name] = value === "true";
        else if (property.type === "number" || property.type === "integer") {
          const numeric = Number(value);
          if (
            !Number.isFinite(numeric) ||
            (property.type === "integer" && !Number.isInteger(numeric))
          ) {
            setError(`Provide a valid ${String(property.type)} for ${name}.`);
            return;
          }
          content[name] = numeric;
        } else content[name] = value;
      }
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
        Object.entries(properties).map(([name, raw]) => {
          const property = object(raw);
          const enumeration = Array.isArray(property.enum)
            ? property.enum
            : property.type === "boolean"
              ? [true, false]
              : null;
          return (
            <p key={name}>
              <label>
                {text(property.title) || name}
                {required.includes(name) ? " (required)" : ""}{" "}
                {enumeration ? (
                  <select
                    disabled={disabled}
                    value={values[name] || ""}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [name]: event.target.value }))
                    }
                  >
                    <option value="">Choose</option>
                    {enumeration.map((option) => (
                      <option key={String(option)} value={String(option)}>
                        {String(option)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    disabled={disabled}
                    autoComplete="off"
                    type={property.type === "string" ? "text" : "number"}
                    step={property.type === "integer" ? 1 : "any"}
                    value={values[name] || ""}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [name]: event.target.value }))
                    }
                  />
                )}
              </label>
              {text(property.description) ? <small> {text(property.description)}</small> : null}
            </p>
          );
        })
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
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setExternalOpened(true)}
              >
                Review the external request
              </a>
              . Opening it does not accept this request.
              <label style={{ display: "block" }}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={externalConsent}
                  onChange={(event) => setExternalConsent(event.target.checked)}
                />{" "}
                I consent to this external interaction.
              </label>
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
