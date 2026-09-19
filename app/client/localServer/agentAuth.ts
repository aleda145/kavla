import { useSyncExternalStore } from "react";

export type AgentAuth = {
  maxToolCalls: number;
  mode: "codex" | "apiKey";
  baseUrl: string;
  model: string;
  hasHeaders: boolean;
  hasApiKey: boolean;
  hasEnvironmentKey: boolean;
  keySource: "config" | "session" | "environment" | "";
};

let auth: AgentAuth = {
  maxToolCalls: 50,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1",
  hasHeaders: false,
  mode: "codex",
  hasApiKey: false,
  hasEnvironmentKey: false,
  keySource: "",
};
const listeners = new Set<() => void>();
export function notifyAgentAuth(value: unknown) {
  if (!value || typeof value !== "object") return;
  const next = value as Partial<AgentAuth>;
  if ((next.mode !== "codex" && next.mode !== "apiKey") || typeof next.hasApiKey !== "boolean") return;
  auth = {
    maxToolCalls: typeof next.maxToolCalls === "number" ? next.maxToolCalls : auth.maxToolCalls,
    baseUrl: typeof next.baseUrl === "string" ? next.baseUrl : auth.baseUrl,
    model: typeof next.model === "string" ? next.model : auth.model,
    hasHeaders: next.hasHeaders === true,
    mode: next.mode,
    hasApiKey: next.hasApiKey,
    hasEnvironmentKey: next.hasEnvironmentKey === true,
    keySource:
      next.keySource === "config" || next.keySource === "session" || next.keySource === "environment"
        ? next.keySource
        : "",
  };
  listeners.forEach((listener) => listener());
}
export function useAgentAuth() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => auth
  );
}
