import type { LocalServerContextType } from "./types";
import { useSyncExternalStore } from "react";
import { getActiveLocalSession } from "../local/localSession";

export type CodexToolCall = {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "cancelled";
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  startedAt: number;
};
export type CodexRun = {
  id: string;
  documentId: string;
  clientId: string;
  threadId: string;
  turnId: string;
  model: string;
  status: "planning" | "running" | "waiting_for_tool" | "completed" | "failed" | "cancelled" | "interrupted";
  prompt: string;
  text: string;
  error?: string;
  activity: string;
  createdAt: number;
  revision: number;
  tools: CodexToolCall[];
};
let runs: CodexRun[] = [];
let cachedRuns: CodexRun[] = [];
let cachedSource: CodexRun[] | null = null;
let cachedDocument: string | undefined;
const listeners = new Set<() => void>();
let clientId: string;
try {
  clientId = sessionStorage.getItem("kavla.codex.client") || crypto.randomUUID();
  sessionStorage.setItem("kavla.codex.client", clientId);
} catch {
  clientId = crypto.randomUUID();
}
export const codexClientId = clientId;
export const isCodexRunActive = (run: CodexRun) => ["planning", "running", "waiting_for_tool"].includes(run.status);
export function notifyCodexRuns(value: unknown) {
  if (!Array.isArray(value)) { if (value === null) value = []; else return; }
  const incoming = value as CodexRun[];
  runs = incoming.filter((run) => run && typeof run.documentId === "string" && typeof run.id === "string" && Array.isArray(run.tools))
    .map((run) => {
      const previous = runs.find((item) => item.id === run.id);
      return previous && previous.revision > run.revision ? previous : run;
    });
  listeners.forEach((listener) => listener());
}
export function getCodexRuns() {
  const documentId = getActiveLocalSession()?.documentId;
  if (cachedSource !== runs || cachedDocument !== documentId) {
    cachedSource = runs;
    cachedDocument = documentId;
    cachedRuns = runs.filter((run) => run.documentId === documentId);
  }
  return cachedRuns;
}
export function useCodexRuns() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getCodexRuns);
}
export async function codexRequest<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/codex/${path}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value), signal,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = (JSON.parse(text) as { error?: string }).error || text; } catch { /* Plain HTTP error. */ }
    throw new Error(message || `Agent request failed (${response.status}).`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
export function cancelCodexRun(runId: string) {
  window.dispatchEvent(new CustomEvent("kavla:cancel-codex-run", { detail: runId }));
  return codexRequest<void>("cancel", { runId });
}
export type CodexGeneration = { sql?: string; name?: string; strategy?: string; title?: string; description?: string; code?: string; dataSql?: string | null };
export type CodexToolEnvironment = {
  runId: string;
  data: LocalServerContextType;
  signal: AbortSignal;
  prompt: string;
  generate: (mode: "sql" | "lens", prompt: string, context: unknown) => Promise<CodexGeneration>;
};
export function createCodexToolEnvironment(run: CodexRun, signal: AbortSignal, data: LocalServerContextType): CodexToolEnvironment {
  return {
    runId: run.id, signal, data, prompt: run.prompt,
    generate: (mode, prompt, context) => codexRequest("generate", { runId: run.id, clientId: codexClientId, mode, prompt, context }, signal),
  };
}
