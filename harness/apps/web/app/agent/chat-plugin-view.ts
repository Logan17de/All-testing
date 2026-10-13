export interface ChatTool {
  id: string;
  title: string;
  pluginId: string;
  status: string;
}
export interface ChatPluginInventory {
  available: ChatTool[];
  restrictions: { model: string[] | null; tools: string[] | null };
}
export function chatPluginInventory(value: unknown): ChatPluginInventory | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.available) || !data.restrictions || typeof data.restrictions !== "object")
    return;
  const available: ChatTool[] = [];
  for (const raw of data.available) {
    if (!raw || typeof raw !== "object") return;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.title !== "string" ||
      typeof item.pluginId !== "string" ||
      typeof item.status !== "string" ||
      available.some((tool) => tool.id === item.id)
    )
      return;
    available.push({
      id: item.id,
      title: item.title,
      pluginId: item.pluginId,
      status: item.status,
    });
  }
  const restrictions = data.restrictions as Record<string, unknown>;
  const scope = (value: unknown): value is string[] | null =>
    value === null ||
    (Array.isArray(value) &&
      value.every((id: unknown) => typeof id === "string" && id.length > 0) &&
      new Set(value).size === value.length);
  if (!scope(restrictions.model) || !scope(restrictions.tools)) return;
  return { available, restrictions: { model: restrictions.model, tools: restrictions.tools } };
}
