export const SETTINGS_GROUPS = ["Personal", "Integrations", "Coding", "Archived"] as const;
export const SETTINGS_SECTIONS = [
  {
    id: "general",
    group: "Personal",
    title: "General",
    description: "Set up your workspace, chat behavior, and notifications.",
    keywords:
      "setup workspace trust folders permissions shortcuts enter full view close notifications sound",
  },
  {
    id: "chat",
    group: "Personal",
    title: "Chat",
    description: "Set default instructions and tool choices for your chats.",
    keywords: "conversation instructions permissions subagents research web tools",
  },
  {
    id: "account",
    group: "Personal",
    title: "Account",
    description: "Manage your ChatGPT connection.",
    keywords: "oauth sign in authorization",
  },
  {
    id: "integrations",
    group: "Integrations",
    title: "Plugins",
    description: "Installed plugins and their granted capabilities.",
    keywords: "tools packages permissions install",
  },
  {
    id: "computer",
    group: "Integrations",
    title: "Computer use",
    description: "Manage a task-scoped desktop session with the local companion.",
    keywords: "desktop monitors windows input screenshots",
  },
  {
    id: "browser",
    group: "Integrations",
    title: "Browser",
    description: "Review the browser session and available capabilities.",
    keywords: "capture sharing profiles status",
  },
  {
    id: "coding",
    group: "Coding",
    title: "Configuration",
    description: "Configure the models used by your chats and graphs.",
    keywords: "models endpoints api keys tools context",
  },
  {
    id: "connections",
    group: "Coding",
    title: "Connections",
    description: "Manage which chats your personal assistant can access.",
    keywords: "assistant authorization child permissions rights",
  },
  {
    id: "archived",
    group: "Archived",
    title: "Archived chats",
    description: "Restore, permanently delete, or set how long to keep archived chats.",
    keywords: "history conversations restore delete retention days never",
  },
] as const;
export type SettingsId = (typeof SETTINGS_SECTIONS)[number]["id"];
export function settingsMatches(query: string) {
  const search = query.trim().toLowerCase();
  return SETTINGS_SECTIONS.filter((section) =>
    `${section.group} ${section.title} ${section.description} ${section.keywords}`
      .toLowerCase()
      .includes(search),
  );
}
export function settingsId(value: string | null): SettingsId {
  return SETTINGS_SECTIONS.find((section) => section.id === value)?.id ?? "general";
}
