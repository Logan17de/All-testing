"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { SettingsWorkspace } from "./settings-workspace";
import type { SettingsId } from "./settings-view";
import "./settings.css";
import "./general-settings.css";
import "./computer-settings.css";

const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function SettingsPopup({
  initialSection = "general",
  onClose,
  onNavigate = onClose,
}: {
  initialSection?: SettingsId;
  onClose: () => void;
  onNavigate?: () => void;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const ref = useRef<HTMLDialogElement>(null);
  const outsidePointer = useRef(false);
  useEffect(() => {
    if (!ready) return;
    const popup = ref.current;
    if (!popup) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!popup.open) popup.showModal();
    return () => {
      popup.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
      window.dispatchEvent(new Event("zet:settings-closed"));
    };
  }, [ready]);
  if (!ready) return null;
  const outside = (x: number, y: number) => {
    const bounds = ref.current?.getBoundingClientRect();
    return Boolean(
      bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom),
    );
  };
  return createPortal(
    <dialog
      ref={ref}
      id="settings-popup"
      className="settingsPage settingsPopup"
      aria-label="Settings"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        outsidePointer.current =
          event.target === event.currentTarget && outside(event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (
          outsidePointer.current &&
          event.target === event.currentTarget &&
          outside(event.clientX, event.clientY)
        )
          onClose();
        outsidePointer.current = false;
      }}
    >
      <button
        type="button"
        className="settingsPopupClose"
        aria-label="Close settings"
        onClick={onClose}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12 M18 6 6 18" />
        </svg>
      </button>
      <SettingsWorkspace initialSection={initialSection} syncUrl={false} onNavigate={onNavigate} />
    </dialog>,
    document.body,
  );
}
