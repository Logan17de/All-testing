export interface DesktopMonitor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
export interface DesktopWindow {
  id: string;
  title: string;
  monitorId?: string;
}
export interface DesktopStatus {
  state: "disabled" | "idle" | "armed";
  generation: number;
  task?: string;
  expiresAt?: number;
  selection?: { monitorId: string; windowId?: string };
  actionsRemaining: number;
  monitors: DesktopMonitor[];
  windows: DesktopWindow[];
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function desktopStatus(value: unknown): DesktopStatus | undefined {
  const status = object(value);
  if (
    !["disabled", "idle", "armed"].includes(String(status.state)) ||
    !Number.isSafeInteger(status.generation) ||
    (status.state === "armed" && !Number.isSafeInteger(status.actionsRemaining)) ||
    !Array.isArray(status.monitors) ||
    !Array.isArray(status.windows)
  )
    return undefined;
  const monitors: DesktopMonitor[] = [];
  for (const raw of status.monitors) {
    const monitor = object(raw);
    if (
      typeof monitor.id !== "string" ||
      ![monitor.x, monitor.y, monitor.width, monitor.height, monitor.scale].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) ||
      (monitor.width as number) <= 0 ||
      (monitor.height as number) <= 0 ||
      (monitor.scale as number) <= 0
    )
      return undefined;
    monitors.push(monitor as unknown as DesktopMonitor);
  }
  const windows: DesktopWindow[] = [];
  for (const raw of status.windows) {
    const window = object(raw);
    if (typeof window.id !== "string" || typeof window.title !== "string") return undefined;
    windows.push({
      id: window.id,
      title: window.title,
      ...(typeof window.monitorId === "string" ? { monitorId: window.monitorId } : {}),
    });
  }
  if (
    status.state === "armed" &&
    (typeof status.task !== "string" ||
      typeof status.expiresAt !== "number" ||
      !Number.isFinite(status.expiresAt))
  )
    return undefined;
  return {
    state: status.state as DesktopStatus["state"],
    generation: status.generation as number,
    actionsRemaining: typeof status.actionsRemaining === "number" ? status.actionsRemaining : 0,
    monitors,
    windows,
    ...(typeof status.task === "string" ? { task: status.task } : {}),
    ...(typeof status.expiresAt === "number" ? { expiresAt: status.expiresAt } : {}),
    ...(typeof object(status.selection).monitorId === "string"
      ? {
          selection: object(status.selection) as unknown as {
            monitorId: string;
            windowId?: string;
          },
        }
      : {}),
  };
}
export function desktopSessionActive(status: DesktopStatus | null, now: number): boolean {
  return status?.state === "armed" && (status.expiresAt || 0) > now;
}
export function desktopArmed(status: DesktopStatus | null, now: number): boolean {
  return desktopSessionActive(status, now) && (status?.actionsRemaining || 0) > 0;
}
export function monitorContains(
  monitor: DesktopMonitor | undefined,
  x: number,
  y: number,
): boolean {
  return (
    monitor !== undefined &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= monitor.x &&
    y >= monitor.y &&
    x < monitor.x + monitor.width &&
    y < monitor.y + monitor.height
  );
}

export interface DesktopConsent {
  id: string;
  generation: number;
  task: string;
  purpose: "input" | "transmission";
  action?: Record<string, unknown>;
  artifactId?: string;
}
export function desktopConsents(value: unknown, status: DesktopStatus | null): DesktopConsent[] {
  if (!Array.isArray(value) || !status || status.state !== "armed") return [];
  return value.flatMap<DesktopConsent>((raw) => {
    const request = object(raw);
    if (
      typeof request.id !== "string" ||
      request.generation !== status.generation ||
      request.task !== status.task
    )
      return [];
    if (
      request.purpose === "input" &&
      request.action &&
      typeof request.action === "object" &&
      !Array.isArray(request.action)
    )
      return [
        {
          id: request.id,
          generation: status.generation,
          task: request.task as string,
          purpose: "input" as const,
          action: object(request.action),
        },
      ];
    if (request.purpose === "transmission" && typeof request.artifactId === "string")
      return [
        {
          id: request.id,
          generation: status.generation,
          task: request.task as string,
          purpose: "transmission" as const,
          artifactId: request.artifactId,
        },
      ];
    return [];
  });
}
