export type ToolScopes = { model: string[]; tools: string[] };
export type ToolActor = {
  chatId: string;
  parentChatId: string | null;
  scopes: { model: string[] | null; tools: string[] | null };
  delegationCeiling: ToolScopes | null;
};
export type ToolRequest = {
  id: string;
  childChatId: string;
  parentChatId: string;
  epoch: number;
  scopes: ToolScopes;
  status: string;
  requiresUser: boolean;
};
export type ToolRights = {
  epoch: number;
  audit: {
    sequence: number;
    epoch: number;
    action: string;
    details: Record<string, unknown>;
    occurredAtMs: number;
  }[];
  catalog: string[];
  actors: ToolActor[];
  requests: ToolRequest[];
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\x00-\x1f\x7f]/u.test(value);
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every(identifier) &&
  new Set(value).size === value.length;
const scopes = (value: unknown, nullable = false): boolean => {
  const item = object(value);
  return (
    !!item &&
    (["model", "tools"] as const).every((key) => ids(item[key]) || (nullable && item[key] === null))
  );
};
export function childToolRights(value: unknown): ToolRights | undefined {
  const data = object(value);
  if (
    !data ||
    !Number.isSafeInteger(data.epoch) ||
    Number(data.epoch) < 0 ||
    !Array.isArray(data.audit) ||
    data.audit.length > 200 ||
    data.audit.some((raw: unknown) => {
      const item = object(raw);
      return (
        !item ||
        !Number.isSafeInteger(item.sequence) ||
        !Number.isSafeInteger(item.epoch) ||
        typeof item.action !== "string" ||
        !object(item.details) ||
        typeof item.occurredAtMs !== "number" ||
        !Number.isFinite(item.occurredAtMs)
      );
    }) ||
    !ids(data.catalog) ||
    !Array.isArray(data.actors) ||
    !Array.isArray(data.requests)
  )
    return;
  if (
    data.actors.some((raw: unknown) => {
      const item = object(raw);
      return (
        !item ||
        !identifier(item.chatId) ||
        !(item.parentChatId === null || identifier(item.parentChatId)) ||
        !scopes(item.scopes, true) ||
        !(item.delegationCeiling === null || scopes(item.delegationCeiling))
      );
    })
  )
    return;
  if (
    data.requests.some((raw: unknown) => {
      const item = object(raw);
      return (
        !item ||
        !identifier(item.id) ||
        !identifier(item.childChatId) ||
        !identifier(item.parentChatId) ||
        !Number.isSafeInteger(item.epoch) ||
        Number(item.epoch) < 0 ||
        !scopes(item.scopes) ||
        !["pending", "granted", "denied", "stale"].includes(String(item.status)) ||
        typeof item.requiresUser !== "boolean"
      );
    })
  )
    return;
  return data as ToolRights;
}
