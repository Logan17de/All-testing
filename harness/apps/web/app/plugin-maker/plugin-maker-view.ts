export interface PluginDraft {
  hash: string;
  files: { path: string; content: string; sha256: string }[];
  requestedCapabilities: string[];
  quarantined: true;
  enabled: false;
}
export function pluginDraft(value: unknown): PluginDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (
    typeof data.hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(data.hash) ||
    data.quarantined !== true ||
    data.enabled !== false ||
    !Array.isArray(data.files) ||
    !Array.isArray(data.requestedCapabilities) ||
    data.requestedCapabilities.some((item: unknown) => typeof item !== "string")
  )
    return;
  const files: PluginDraft["files"] = [];
  for (const raw of data.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const file = raw as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      !file.path ||
      typeof file.content !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      files.some((item) => item.path === file.path)
    )
      return;
    files.push({ path: file.path, content: file.content, sha256: file.sha256 });
  }
  return {
    hash: data.hash,
    files,
    requestedCapabilities: [...(data.requestedCapabilities as string[])],
    quarantined: true,
    enabled: false,
  };
}

export function hasExecutedSandboxTests(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return (
    report.mode === "required-os-sandbox" && report.executed === true && report.passed === true
  );
}
