import type { SVGProps } from "react";

const paths = {
  "panel-left": "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M9 3v18",
  "panel-right": "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M15 3v18",
  plus: "M12 5v14 M5 12h14",
  compose:
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z",
  chat: "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z",
  assistant: "M5 5h14v11H9l-4 4Z M8 9h8 M8 12h5",
  folder: "M3 6h7l2 2h9v12H3Z",
  "chevron-right": "m9 6 6 6-6 6",
  settings:
    "M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z M15 12a3 3 0 1 1-6 0 3 3 0 1 1 6 0",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
  x: "m6 6 12 12 M18 6 6 18",
  graph: "M3 3h6v6H3Z M15 15h6v6h-6Z M15 3h6v6h-6Z M9 6h6 M6 9v9h9",
  terminal: "m5 6 6 6-6 6 M13 18h6",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  more: "M4 12h.01 M12 12h.01 M20 12h.01",
  "arrow-up": "M12 19V5 m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6Z",
  "external-link":
    "M15 3h6v6 M10 14 21 3 M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
  refresh: "M20 7v5h-5 M4 17v-5h5 M6.1 6.1A8 8 0 0 1 20 10 M4 14a8 8 0 0 0 13.9 3.9",
  download: "M12 3v12 m-5-5 5 5 5-5 M5 17v4h14v-4",
  help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4 M12 17h.01",
  undo: "M3 4v6h6 M3 10a8 8 0 1 1 1 8",
  redo: "M21 4v6h-6 M21 10a8 8 0 1 0-1 8",
  link: "M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l2-2",
  unlink: "m3 3 18 18 M10 6l3-3a5 5 0 0 1 7 7l-2 2 M14 18l-3 3a5 5 0 0 1-7-7l2-2",
} as const;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
