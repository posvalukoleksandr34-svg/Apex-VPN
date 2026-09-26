import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * One highlight that slides to the active item of a group (segmented
 * control, tab underline), like AppKit's segmented control.
 *
 * Returns props for the group element: a ref, `--indicator-x` /
 * `--indicator-w`, and `data-indicator`:
 * * absent until measured (the active item paints its own highlight);
 * * "ready" once measured: the indicator appears in place, no transition,
 *   so it doesn't fly in when a page opens;
 * * "animate" from the next frame on: every change springs.
 *
 * `activeKey` changes whenever the active item (or the item set) does.
 */
export function useSlidingIndicator<T extends HTMLElement>(activeSelector: string, activeKey: string) {
  const ref = useRef<T>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  const [phase, setPhase] = useState<"ready" | "animate" | undefined>();

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const el = root.querySelector<HTMLElement>(activeSelector);
      setBox((prev) => {
        if (!el) return null;
        const next = { x: el.offsetLeft, w: el.offsetWidth };
        return prev && prev.x === next.x && prev.w === next.w ? prev : next;
      });
    };
    measure();
    // Labels change width when fonts load or the language changes.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    root.querySelectorAll<HTMLElement>(":scope > *").forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [activeSelector, activeKey]);

  const measured = box !== null;
  useEffect(() => {
    if (!measured) {
      setPhase(undefined);
      return;
    }
    setPhase((p) => p ?? "ready");
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase("animate"));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [measured]);

  const style = box ? ({ "--indicator-x": `${box.x}px`, "--indicator-w": `${box.w}px` } as CSSProperties) : undefined;
  return { ref, style, "data-indicator": measured ? phase : undefined };
}
