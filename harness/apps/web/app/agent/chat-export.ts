export type ReadableChatExport = {
  filename: string;
  content: string;
  mediaType: "text/markdown; charset=utf-8";
};
export function readableChatExport(value: unknown): ReadableChatExport {
  const result =
    value && typeof value === "object" ? (value as Record<string, unknown>).export : undefined;
  if (!result || typeof result !== "object")
    throw new Error("The runtime did not return a readable chat export.");
  const file = result as Record<string, unknown>;
  if (
    typeof file.filename !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(file.filename) ||
    typeof file.content !== "string" ||
    file.mediaType !== "text/markdown; charset=utf-8"
  )
    throw new Error("The runtime returned an invalid chat export.");
  return file as ReadableChatExport;
}
