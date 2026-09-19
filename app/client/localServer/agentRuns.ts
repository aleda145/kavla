import type { LocalServerContextType } from "./types";
import { useSyncExternalStore } from "react";
import { getActiveLocalSession } from "../local/localSession";
import { randomUUID } from "../../util/randomUUID";

export type AgentToolCall = {
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "cancelled";
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  startedAt: number;
};
export type AgentRun = {
  thoughts?: { id: string; text: string }[];
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
  tools: AgentToolCall[];
};
let runs: AgentRun[] = [];
let cachedRuns: AgentRun[] = [];
let cachedSource: AgentRun[] | null = null;
let cachedDocument: string | undefined;
const listeners = new Set<() => void>();
let clientId: string;
try {
  clientId = sessionStorage.getItem("kavla.agent.client") || randomUUID();
  sessionStorage.setItem("kavla.agent.client", clientId);
} catch {
  clientId = randomUUID();
}
export const agentClientId = clientId;
export const isAgentRunActive = (run: AgentRun) => ["planning", "running", "waiting_for_tool"].includes(run.status);
export function notifyAgentRuns(value: unknown) {
  if (!Array.isArray(value)) {
    if (value === null) value = [];
    else return;
  }
  const incoming = value as AgentRun[];
  runs = incoming
    .filter(
      (run) => run && typeof run.documentId === "string" && typeof run.id === "string" && Array.isArray(run.tools)
    )
    .map((run) => {
      const previous = runs.find((item) => item.id === run.id);
      return previous && previous.revision > run.revision ? previous : run;
    });
  listeners.forEach((listener) => listener());
}
export function getAgentRuns() {
  const documentId = getActiveLocalSession()?.documentId;
  if (cachedSource !== runs || cachedDocument !== documentId) {
    cachedSource = runs;
    cachedDocument = documentId;
    cachedRuns = runs.filter((run) => run.documentId === documentId);
  }
  return cachedRuns;
}
export function useAgentRuns() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getAgentRuns);
}
export async function agentRequest<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error || text;
    } catch {
      /* Plain HTTP error. */
    }
    throw new Error(message || `Agent request failed (${response.status}).`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
export function cancelAgentRun(runId: string) {
  window.dispatchEvent(new CustomEvent("kavla:cancel-agent-run", { detail: runId }));
  return agentRequest<void>("cancel", { runId });
}
export type LensGeneration = { title?: string; description?: string; code: string; dataSql?: string | null };
export type AgentToolEnvironment = {
  runId: string;
  data: LocalServerContextType;
  signal: AbortSignal;
  prompt: string;
  generateLens: (prompt: string, context: unknown) => Promise<LensGeneration>;
};
export function createAgentToolEnvironment(
  run: AgentRun,
  signal: AbortSignal,
  data: LocalServerContextType
): AgentToolEnvironment {
  return {
    runId: run.id,
    signal,
    data,
    prompt: run.prompt,
    generateLens: (prompt, context) =>
      agentRequest("generate-lens", { runId: run.id, clientId: agentClientId, prompt, context }, signal),
  };
}
