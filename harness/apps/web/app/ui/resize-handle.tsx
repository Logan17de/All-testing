"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clampPanelWidth } from "../../lib/panel-width";

export function usePanelWidth(storageKey: string, defaultValue: number, min: number, max: number) {
  const [width, setWidth] = useState(defaultValue);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        setWidth(clampPanelWidth(localStorage.getItem(storageKey), defaultValue, min, max));
      } catch {
        /* Private browsing must not prevent resizing. */
      }
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [storageKey, defaultValue, min, max]);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* Panel preferences are optional. */
    }
  }, [width, storageKey, ready]);
  const update = useCallback(
    (value: number) => setWidth(clampPanelWidth(value, defaultValue, min, max)),
    [defaultValue, min, max],
  );
  return [width, update] as const;
}

export function ResizeHandle({
  label,
  controls,
  value,
  min,
  max,
  defaultValue,
  onChange,
  side,
  className = "",
}: {
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  side: "left" | "right";
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number; original: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useEffect(() => {
    const panel = document.getElementById(controls);
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const width = panel.getBoundingClientRect().width;
      if (width > 0) setMeasuredWidth(Math.round(width));
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [controls]);
  const shownWidth = measuredWidth ?? value;
  const direction = side === "left" ? 1 : -1;
  const update = (next: number) => onChange(clampPanelWidth(next, defaultValue, min, max));
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clampPanelWidth(shownWidth, defaultValue, min, max)}
      aria-valuetext={`${Math.round(shownWidth)} pixels`}
      title={`${label}. Drag or use arrow keys. Double-click or press Enter to reset.`}
      className={`resizeHandle${dragging ? " resizeHandle--dragging" : ""} ${className}`}
      onDoubleClick={() => update(defaultValue)}
      onKeyDown={(event) => {
        let next: number;
        const current = document.getElementById(controls)?.getBoundingClientRect().width || value;
        const step = event.shiftKey ? 40 : 10;
        if (event.key === "ArrowLeft") next = current - step * direction;
        else if (event.key === "ArrowRight") next = current + step * direction;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "Enter") next = defaultValue;
        else return;
        event.preventDefault();
        update(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        const actual = document.getElementById(controls)?.getBoundingClientRect().width;
        drag.current = { x: event.clientX, width: actual || value, original: value };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (drag.current) update(drag.current.width + (event.clientX - drag.current.x) * direction);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        if (drag.current) update(drag.current.original);
        drag.current = null;
        setDragging(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
    />
  );
}
