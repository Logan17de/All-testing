import { desktopConsents, type DesktopStatus } from "./desktop-view";
export interface DesktopImageDestination {
  runId: string;
  sessionId: string;
  modelId: string;
  accountId: string | null;
  maxUses: number;
  expiresAtMs: number;
}
export interface DesktopImageCaptureScope {
  monitorId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  windowId?: string;
}
export interface DesktopImageConsent {
  id: string;
  task: string;
  generation: number;
  artifactId: string;
  destination?: DesktopImageDestination;
  captureScope?: DesktopImageCaptureScope;
  blockedReason?: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 320 &&
  !/[\x00-\x1f\x7f]/u.test(value);
export function desktopImageConsents(
  value: unknown,
  status: DesktopStatus | null,
  now: number,
): DesktopImageConsent[] {
  if (!Array.isArray(value) || !status) return [];
  return desktopConsents(value, status)
    .filter((request) => request.purpose === "transmission")
    .map((request) => {
      const base = {
        id: request.id,
        task: request.task,
        generation: request.generation,
        artifactId: request.artifactId!,
      };
      const raw = object(value.find((item) => object(item).id === request.id));
      const destination = object(raw.destination);
      const captureScope = object(raw.captureScope);
      const validCaptureScope =
        identifier(captureScope.monitorId) &&
        [captureScope.x, captureScope.y, captureScope.width, captureScope.height].every(
          Number.isSafeInteger,
        ) &&
        Number(captureScope.width) > 0 &&
        Number(captureScope.height) > 0 &&
        (captureScope.windowId === undefined || identifier(captureScope.windowId)) &&
        Object.keys(captureScope).every((key) =>
          ["monitorId", "x", "y", "width", "height", "windowId"].includes(key),
        );
      if (!Number.isFinite(now) || !status.expiresAt || status.expiresAt <= now)
        return { ...base, blockedReason: "This desktop task has expired. Reject this request." };
      if (
        !validCaptureScope ||
        Object.keys(destination).some(
          (key) =>
            !["runId", "sessionId", "modelId", "accountId", "maxUses", "expiresAtMs"].includes(key),
        ) ||
        !identifier(destination.runId) ||
        !identifier(destination.sessionId) ||
        !identifier(destination.modelId) ||
        !(destination.accountId === null || identifier(destination.accountId)) ||
        !Number.isInteger(destination.maxUses) ||
        Number(destination.maxUses) < 1 ||
        Number(destination.maxUses) > 8 ||
        !Number.isFinite(destination.expiresAtMs) ||
        Number(destination.expiresAtMs) <= now ||
        Number(destination.expiresAtMs) > status.expiresAt
      )
        return {
          ...base,
          blockedReason:
            "A complete, supported current-turn destination is required. Reject this request.",
        };
      return {
        ...base,
        captureScope: {
          monitorId: captureScope.monitorId as string,
          x: Number(captureScope.x),
          y: Number(captureScope.y),
          width: Number(captureScope.width),
          height: Number(captureScope.height),
          ...(typeof captureScope.windowId === "string" ? { windowId: captureScope.windowId } : {}),
        },
        destination: {
          runId: destination.runId,
          sessionId: destination.sessionId,
          modelId: destination.modelId,
          accountId: destination.accountId,
          maxUses: Number(destination.maxUses),
          expiresAtMs: Number(destination.expiresAtMs),
        },
      };
    });
}
export function desktopScreenshotScope(status: DesktopStatus | null): string {
  const monitor = status?.monitors.find((item) => item.id === status.selection?.monitorId);
  if (!monitor) return "Screenshot scope is unavailable.";
  return `Entire monitor ${monitor.id}: ${monitor.width} × ${monitor.height} physical pixels, origin (${monitor.x}, ${monitor.y}), scale ${monitor.scale}. Includes all visible apps in this monitor; the window selection does not crop screenshots.`;
}

export function desktopImageScope(request: DesktopImageConsent): string {
  const scope = request.captureScope;
  if (!scope)
    return "The immutable screenshot capture scope is unavailable; this request cannot be approved.";
  return `Entire captured monitor ${scope.monitorId}: ${scope.width} × ${scope.height} physical pixels, origin (${scope.x}, ${scope.y}). Includes all visible apps in this monitor; window selection does not crop screenshots.${scope.windowId ? ` Keyboard/focus window: ${scope.windowId}.` : ""}`;
}
