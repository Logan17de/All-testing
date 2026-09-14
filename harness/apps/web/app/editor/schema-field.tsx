"use client";

import { useId, useState } from "react";

import { schemaTypeOf, type JsonSchema, type JsonValue } from "../../lib/graph-document";

interface SchemaFieldProps {
  readonly label: string;
  readonly schema: JsonSchema;
  readonly value: JsonValue | undefined;
  readonly required?: boolean;
  readonly hint?: string;
  readonly onChange: (value: JsonValue | undefined) => void;
}

/**
 * One form control generated from a JSON Schema.
 *
 * Covers what node configuration usually is — strings, numbers, booleans and
 * enums — and falls back to a JSON editor for anything else. It does not
 * validate against the schema itself: the compiler does, and reports the result
 * on the node, so there is exactly one place that decides what is valid.
 */
export function SchemaField({
  label,
  schema,
  value,
  required = false,
  hint,
  onChange,
}: SchemaFieldProps) {
  const id = useId();
  const type = schemaTypeOf(schema);
  const choices = typeof schema === "object" ? schema.enum : undefined;
  const description = hint ?? (typeof schema === "object" ? schema.description : undefined);
  const labelText = required ? `${label} (required)` : label;
  const help =
    description === undefined ? null : <span className="field__hint">{description}</span>;

  if (choices !== undefined && choices.length > 0) {
    const current = value === undefined ? "" : JSON.stringify(value);
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {labelText}
        </label>
        <select
          id={id}
          className="field__input"
          value={current}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : (JSON.parse(raw) as JsonValue));
          }}
        >
          <option value="">Not set</option>
          {choices.map((choice) => {
            const encoded = JSON.stringify(choice);
            return (
              <option key={encoded} value={encoded}>
                {typeof choice === "string" ? choice : encoded}
              </option>
            );
          })}
        </select>
        {help}
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <div className="field">
        <label className="field__check">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          {labelText}
        </label>
        {help}
      </div>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {labelText}
        </label>
        <input
          id={id}
          className="field__input"
          type="number"
          step={type === "integer" ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
        />
        {help}
      </div>
    );
  }

  if (type === "string") {
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {labelText}
        </label>
        <input
          id={id}
          className="field__input"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : raw);
          }}
        />
        {help}
      </div>
    );
  }

  return (
    <JsonField
      id={id}
      label={`${labelText} (JSON)`}
      value={value}
      description={description}
      onChange={onChange}
    />
  );
}

function JsonField({
  id,
  label,
  value,
  description,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: JsonValue | undefined;
  readonly description: string | undefined;
  readonly onChange: (value: JsonValue | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="field__input"
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (draft.trim() === "") {
            setError(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(draft) as JsonValue);
            setError(null);
          } catch {
            setError("That is not valid JSON, so the previous value is kept.");
          }
        }}
      />
      {error === null ? (
        description === undefined ? null : (
          <span className="field__hint">{description}</span>
        )
      ) : (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
