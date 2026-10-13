import type { SettingsId } from "./settings-view";

export function SettingsIcon({ kind }: { kind: SettingsId | "search" }) {
  const paths: Record<SettingsId | "search", React.ReactNode> = {
    chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
    general: (
      <>
        <path d="m9 3-1 3-3 1-2 3 2 2v3l3 2 3-1 3 1 3-2v-3l2-2-2-3-3-1-1-3Z" />
        <circle cx="11" cy="11" r="3" />
      </>
    ),
    account: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="9" r="3" />
        <path d="M6 19v-2a6 6 0 0 1 12 0v2" />
      </>
    ),
    integrations: (
      <>
        <path d="M9 3h6v5h3a3 3 0 1 1 0 6h-3v7H9v-7H6a3 3 0 1 1 0-6h3Z" />
      </>
    ),
    computer: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8 M12 17v4" />
      </>
    ),
    browser: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 9h18 M7 6.5h.01 M10 6.5h.01" />
      </>
    ),
    coding: (
      <>
        <path d="M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1" />
        <circle cx="12" cy="12" r="5" />
      </>
    ),
    connections: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18 M12 3c6 5 6 13 0 18 M12 3c-6 5-6 13 0 18" />
      </>
    ),
    archived: (
      <>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <path d="M5 9v11h14V9 M9 13h6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
  };
  return (
    <svg
      className="settingsIcon"
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[kind]}
    </svg>
  );
}
