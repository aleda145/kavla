import { useSyncExternalStore } from "react";
import { sessionFetch } from "../client/backendCompute";

export interface DuckDBStats {
  state: "standby" | "starting" | "stopped" | "idle" | "busy";
  pid?: number;
  uptimeSeconds?: number;
  residentBytes?: number;
  peakResidentBytes?: number;
  swapBytes?: number;
  threads?: number;
  duckdbLimitBytes?: number;
  sharedLimitBytes?: number;
  error?: string;
  metricsError?: string;
}

type Snapshot = { stats: DuckDBStats | null; error: string | null };
let snapshot: Snapshot = { stats: null, error: null };
const listeners = new Set<() => void>();
let stopPolling: (() => void) | null = null;

function startPolling() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  async function poll() {
    if (stopped || controller || document.hidden) return;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5000);
    try {
      const response = await sessionFetch("/api/session/compute-stats", { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not read DuckDB stats (HTTP ${response.status})`);
      const stats: DuckDBStats = await response.json();
      if (!stopped) snapshot = { stats, error: null };
    } catch (error) {
      if (!stopped) snapshot = { stats: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!stopped) {
        listeners.forEach((listener) => listener());
        timer = setTimeout(poll, 2000);
      }
    }
  }
  const onVisibility = () => {
    clearTimeout(timer);
    if (!document.hidden) void poll();
  };
  document.addEventListener("visibilitychange", onVisibility);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

function resetPolling() {
  stopPolling?.();
  snapshot = { stats: null, error: null };
  listeners.forEach((listener) => listener());
  stopPolling = startPolling();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    stopPolling = startPolling();
    window.addEventListener("kavla:backend-reset", resetPolling);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopPolling?.();
      stopPolling = null;
      window.removeEventListener("kavla:backend-reset", resetPolling);
      snapshot = { stats: null, error: null };
    }
  };
}

export function useDuckDBStats() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
