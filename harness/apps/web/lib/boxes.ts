/**
 * The boxes: a Text box a person types into, a Model that answers the text on
 * its prompt, and an Output box that shows what reached it after a run.
 *
 * They are ordinary nodes to the runtime. The canvas treats the two boxes
 * specially only in what it draws inside them: a text area in the Text box, and
 * the recorded text in the Output box.
 */

export const TEXT_BOX_TYPE = "harness.text-box";
export const OUTPUT_BOX_TYPE = "harness.output-box";
export const ASK_MODEL_TYPE = "harness.ask-model";

/** Most-used first: the boxes lead the palette, in the order a graph reads. */
const FIRST: readonly string[] = [TEXT_BOX_TYPE, ASK_MODEL_TYPE, OUTPUT_BOX_TYPE];

/** The palette with the boxes first and everything else in the order it came. */
export function orderPalette<T extends { readonly manifest: { readonly type: string } }>(
  entries: readonly T[],
): readonly T[] {
  const rank = (entry: T): number => {
    const index = FIRST.indexOf(entry.manifest.type);
    return index === -1 ? FIRST.length : index;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => rank(left.entry) - rank(right.entry) || left.index - right.index)
    .map(({ entry }) => entry);
}

/**
 * The text a node put out, from its attempt's recorded outputs.
 *
 * A run records each output as `{ kind: "inline", value }`; anything else — an
 * output kept elsewhere, or none — is not text this page can show.
 */
export function recordedText(outputs: unknown, port = "text"): string | undefined {
  if (typeof outputs !== "object" || outputs === null) return undefined;
  const recorded = (outputs as Record<string, unknown>)[port];
  if (typeof recorded !== "object" || recorded === null) return undefined;
  const { kind, value } = recorded as { readonly kind?: unknown; readonly value?: unknown };
  return kind === "inline" && typeof value === "string" ? value : undefined;
}

/** A Text box's text, from its configuration. */
export function textBoxValue(config: Readonly<Record<string, unknown>>): string {
  const text = config["text"];
  return typeof text === "string" ? text : "";
}
