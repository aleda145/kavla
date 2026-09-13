import { useSyncExternalStore } from "react";

export type CodexAuth = {
  mode: "codex" | "apiKey";
  baseUrl: string;
  model: string;
  hasHeaders: boolean;
  hasApiKey: boolean;
  hasEnvironmentKey: boolean;
  keySource: "session" | "environment" | "";
};

let auth: CodexAuth = { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", hasHeaders: false, mode: "codex", hasApiKey: false, hasEnvironmentKey: false, keySource: "" };
const listeners = new Set<() => void>();
export function notifyCodexAuth(value: unknown) {
  if (!value || typeof value !== "object") return;
  const next = value as Partial<CodexAuth>;
  if ((next.mode !== "codex" && next.mode !== "apiKey") || typeof next.hasApiKey !== "boolean") return;
  auth = { baseUrl: typeof next.baseUrl === "string" ? next.baseUrl : auth.baseUrl, model: typeof next.model === "string" ? next.model : auth.model, hasHeaders: next.hasHeaders === true, mode: next.mode, hasApiKey: next.hasApiKey, hasEnvironmentKey: next.hasEnvironmentKey === true, keySource: next.keySource === "session" || next.keySource === "environment" ? next.keySource : "" };
  listeners.forEach((listener) => listener());
}
export function useCodexAuth() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => auth);
}
