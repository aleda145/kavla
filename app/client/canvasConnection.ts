import { useSyncExternalStore } from "react";
import { randomUUID } from "../util/randomUUID";

export type RuntimeEvent = { stream: "cli" | "agent" | "editor"; name: string; data: unknown };
type ConnectionState = { status: "connecting" | "ready" | "disconnected" | "blocked" | "transferred"; message: string };
const canvasPath = window.location.pathname.replace(/\/$/, "");
const clientId = randomUUID();
let token: string | null = null;
let generation: string | null = null;
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let state: ConnectionState = { status: "connecting", message: "Opening canvas…" };
let stopped = false;
const listeners = new Set<() => void>();
const eventListeners = new Set<(event: RuntimeEvent) => void>();
const snapshots = new Map<string, RuntimeEvent>();

export function canvasApiURL(path: string): string {
  if (path.startsWith("/api/")) return `${canvasPath}${path}`;
  return path;
}
// Per-page storage also keeps a disconnected editor's unsent changes separate
// from a replacement editor in another tab. The archive is the load authority.
export function canvasPersistenceKey(): string {
  return `kavla-canvas:${canvasPath}:${clientId}`;
}
export function editorToken(): string | null {
  return token;
}
export function getCanvasConnection(): ConnectionState {
  return state;
}
export function subscribeCanvasConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useCanvasConnection(): ConnectionState {
  return useSyncExternalStore(subscribeCanvasConnection, getCanvasConnection);
}
function publish(status: ConnectionState["status"], message: string): void {
  state = { status, message };
  listeners.forEach((listener) => listener());
}
export function subscribeRuntimeEvents(listener: (event: RuntimeEvent) => void): () => void {
  eventListeners.add(listener);
  snapshots.forEach(listener);
  return () => {
    eventListeners.delete(listener);
  };
}
export function connectCanvas(transfer = false): void {
  if (socket) return;
  stopped = false;
  clearTimeout(retryTimer);
  publish("connecting", "Connecting to the canvas…");
  const url = new URL(canvasApiURL("/api/runtime/events"), window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", clientId);
  if (generation) url.searchParams.set("generation", generation);
  if (transfer) url.searchParams.set("transfer", "true");
  const connection = new WebSocket(url);
  socket = connection;
  const timeout = setTimeout(() => connection.close(), 10_000);
  connection.onmessage = (message: MessageEvent<string>) => {
    if (socket !== connection) return;
    const event = JSON.parse(message.data) as RuntimeEvent;
    if (event.stream === "editor") {
      clearTimeout(timeout);
      if (event.name === "opening") {
        publish("connecting", (event.data as { message: string }).message);
      } else if (event.name === "ready") {
        const data = event.data as { token: string; generation: string };
        token = data.token;
        generation = data.generation;
        publish("ready", "");
      } else if (event.name === "save-request" || event.name === "transfer-cancelled") {
        if (event.name === "save-request") snapshots.set("editor:save-request", event);
        else snapshots.delete("editor:save-request");
        eventListeners.forEach((listener) => listener(event));
      } else if (event.name === "blocked" || event.name === "transferred") {
        snapshots.delete("editor:save-request");
        token = null;
        stopped = true;
        publish(event.name, (event.data as { message: string }).message);
      }
      return;
    }
    if (event.name === "snapshot") {
      for (const key of snapshots.keys()) if (key.startsWith(`${event.stream}:`)) snapshots.delete(key);
    }
    if (["snapshot", "sources", "status", "models", "runs", "auth"].includes(event.name)) {
      snapshots.set(`${event.stream}:${event.name}`, event);
    }
    eventListeners.forEach((listener) => listener(event));
  };
  connection.onclose = () => {
    clearTimeout(timeout);
    if (socket !== connection) return;
    socket = null;
    token = null;
    snapshots.delete("editor:save-request");
    if (stopped) return;
    publish("disconnected", "Connection lost. Your local changes are kept while Kavla reconnects.");
    // Retry a lost connection normally; a save-and-open action is never replayed.
    retryTimer = setTimeout(() => connectCanvas(), 1500);
  };
  connection.onerror = () => connection.close();
}
export function saveAndOpenCanvas(): void {
  disconnectCanvas();
  generation = null;
  snapshots.clear();
  connectCanvas(true);
}
export function disconnectCanvas(): void {
  stopped = true;
  clearTimeout(retryTimer);
  token = null;
  const previous = socket;
  socket = null;
  previous?.close();
}
window.addEventListener("pageshow", (event) => {
  if (event.persisted && state.status !== "transferred") connectCanvas();
});
