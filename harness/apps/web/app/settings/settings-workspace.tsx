"use client";
import { useEffect, useRef, useState } from "react";
import { DesktopSession } from "../agent/desktop-session";
import { GeneralSettings } from "./general-settings";
import { ChatSettings } from "./chat-settings";
import { AccountSettings, ModelSettings } from "./model-settings";
import { ArchivedSettings } from "./archived-settings";
import { PluginSettings, BrowserSettings, ConnectionSettings } from "./integration-settings";
import { SettingsIcon } from "./settings-icon";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  settingsMatches,
  type SettingsId,
} from "./settings-view";

export function SettingsWorkspace({
  initialSection,
  syncUrl = true,
  onNavigate,
}: {
  initialSection: SettingsId;
  syncUrl?: boolean;
  onNavigate?: () => void;
}) {
  const [selected, setSelected] = useState(initialSection);
  const [query, setQuery] = useState("");
  const content = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const matches = settingsMatches(query);
  const section = SETTINGS_SECTIONS.find((item) => item.id === selected)!;
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      navigation.current
        ?.querySelector('[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, query]);
  function choose(id: SettingsId) {
    setSelected(id);
    content.current?.scrollTo({ top: 0 });
    if (!syncUrl) return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", id);
    window.history.replaceState(null, "", url);
  }
  return (
    <div className="settingsLayout">
      <aside className="settingsSidebar" aria-label="Settings sections">
        <h1>Settings</h1>
        <label className="settingsSearch">
          <SettingsIcon kind="search" />
          <span className="sr-only">Search settings</span>
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <nav ref={navigation} aria-label="Settings navigation">
          {SETTINGS_GROUPS.map((group) => {
            const items = matches.filter((item) => item.group === group);
            return items.length ? (
              <div className="settingsGroup" key={group}>
                <p>{group}</p>
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-current={selected === item.id ? "page" : undefined}
                    onClick={() => choose(item.id)}
                  >
                    <SettingsIcon kind={item.id} />
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
            ) : null;
          })}
          {!matches.length ? (
            <p className="settingsMuted" role="status">
              No settings match &quot;{query}&quot;.
            </p>
          ) : null}
        </nav>
      </aside>
      <section
        ref={content}
        className="settingsContent"
        aria-labelledby="settings-panel-title"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          const link = event.target instanceof Element ? event.target.closest("a") : null;
          if (link?.getAttribute("href")?.startsWith("/")) onNavigate?.();
        }}
      >
        <header className="settingsPanelHeader">
          <h2 id="settings-panel-title">{section.title}</h2>
          <p className="settingsMuted">{section.description}</p>
        </header>
        {selected === "general" && <GeneralSettings onOpenChatSettings={() => choose("chat")} />}
        {selected === "chat" && <ChatSettings />}
        {selected === "account" && <AccountSettings />}
        {selected === "integrations" && <PluginSettings />}
        {selected === "computer" && (
          <div className="settingsEmbedded settingsComputer">
            <DesktopSession />
          </div>
        )}
        {selected === "browser" && <BrowserSettings />}
        {selected === "coding" && <ModelSettings />}
        {selected === "connections" && <ConnectionSettings />}
        {selected === "archived" && <ArchivedSettings />}
      </section>
    </div>
  );
}
