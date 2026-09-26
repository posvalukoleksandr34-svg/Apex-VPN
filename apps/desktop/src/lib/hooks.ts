import { useEffect, useState } from "react";

/** Re-renders every `ms` with the current time (for live durations). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
  return now;
}

/** Runs an async function, tracking loading/error; the last call wins. */
export function useAsync<T>() {
  const [state, setState] = useState<{ loading: boolean; error: unknown; data: T | undefined }>({ loading: false, error: null, data: undefined });
  const run = async (fn: () => Promise<T>) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      setState({ loading: false, error: null, data });
      return data;
    } catch (error) {
      setState((s) => ({ ...s, loading: false, error }));
      return undefined;
    }
  };
  return { ...state, run };
}
