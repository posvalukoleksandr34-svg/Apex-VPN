import { useEffect } from "react";
import { useNavigate } from "react-router";
import { connect, disconnect } from "@/app/actions";
import { transport } from "@/app/transportRef";
import { describe, primaryIntent } from "@/features/connection/status";
import { useApp } from "@/state/store";
import type { ShortcutId } from "@/state/types";

/** "Ctrl+Shift+C" matches a KeyboardEvent? */
export function matches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.at(-1)!;
  // "Ctrl" means the platform's primary modifier (Ctrl, or Cmd on macOS).
  const wantPrimary = parts.includes("ctrl") || parts.includes("cmd");
  if (wantPrimary !== (e.ctrlKey || e.metaKey)) return false;
  if (parts.includes("shift") !== e.shiftKey || parts.includes("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

/** App-level shortcuts, tray actions, and the global show/hide shortcut. */
export function useGlobalShortcuts({ openSearch }: { openSearch(): void }) {
  const navigate = useNavigate();
  const shortcuts = useApp((s) => s.prefs.shortcuts);

  useEffect(() => {
    const run = (id: ShortcutId | "toggle") => {
      const { service, tunnel } = useApp.getState();
      switch (id) {
        case "toggleConnection":
        case "toggle": {
          const intent = primaryIntent(describe(service, tunnel));
          if (intent === "connect") void connect();
          if (intent === "disconnect") void disconnect();
          break;
        }
        case "disconnect":
          void disconnect();
          break;
        case "openServers":
          navigate("/servers");
          break;
        case "search":
          openSearch();
          break;
        case "openSettings":
          navigate("/settings");
          break;
        default:
          break;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.closest("input, textarea, [contenteditable=true]") && !(e.ctrlKey || e.metaKey);
      if (typing) return;
      for (const [id, combo] of Object.entries(shortcuts) as [ShortcutId, string][]) {
        if (id === "toggleWindow") continue; // global, handled by the OS
        if (matches(combo, e)) {
          e.preventDefault();
          run(id);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const offAction = transport().app.onAppAction((action) => {
      if (action === "connect") void connect();
      else if (action === "disconnect") void disconnect();
      else if (action === "toggle") run("toggle");
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      offAction();
    };
  }, [shortcuts, navigate, openSearch]);

  useEffect(() => {
    void transport().app.setGlobalShortcut(shortcuts.toggleWindow || null);
  }, [shortcuts.toggleWindow]);
}
