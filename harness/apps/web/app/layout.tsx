import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import "./workbench.css";
import "./app-shell.css";
import { AppShell } from "./app-shell";

export const metadata: Metadata = {
  title: "Zet Harness",
  description: "Provider-neutral AI harness for models, tools, goals, memory, and agent workflows.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
