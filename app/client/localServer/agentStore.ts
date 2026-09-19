import { useEffect, useState } from "react";

export type AgentStatusState = "checking" | "ready" | "missing" | "auth_required" | "error";

export type AgentStatus = {
  state: AgentStatusState;
  message: string;
};

export type AgentModel = {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  isDefault: boolean;
};

export type AgentModelSelection = {
  models: AgentModel[];
  mainModel: string;
};

export type AgentEvent = {
  eventType:
    "started" | "message_delta" | "tool_started" | "tool_finished" | "completed" | "cancelled" | "error" | "warning";
  data: Record<string, unknown>;
};

export type AgentToolRequest = {
  arguments: Record<string, unknown>;
  callId: string;
  threadId: string;
  tool: string;
  turnId: string;
};

export type AgentThread = {
  threadId: string;
  resumed: boolean;
  model?: string;
};

const statusListeners = new Set<(status: AgentStatus) => void>();
const eventListeners = new Set<(event: AgentEvent) => void>();
const toolListeners = new Set<(request: AgentToolRequest) => void>();
const threadListeners = new Set<(thread: AgentThread) => void>();
const modelListeners = new Set<(selection: AgentModelSelection) => void>();

const MAIN_MODEL_KEY = "kavla.agent.mainModel";

let currentStatus: AgentStatus = {
  state: "checking",
  message: "Preparing Agent connection…",
};

let currentModels: AgentModelSelection = {
  models: [],
  mainModel: "",
};

function storedModel(key: string): string {
  try {
    return window.localStorage.getItem(key)?.trim() ?? "";
  } catch {
    return "";
  }
}

function persistModel(key: string, model: string) {
  try {
    window.localStorage.setItem(key, model);
  } catch {
    // The current session still uses the selection when browser storage is unavailable.
  }
}

function availableModel(models: AgentModel[], requested: string): string {
  return models.find((model) => model.model === requested || model.id === requested)?.model ?? "";
}

function defaultMainModel(models: AgentModel[]): string {
  return (
    availableModel(models, storedModel(MAIN_MODEL_KEY)) ||
    availableModel(models, "gpt-5.6-sol") ||
    models.find((model) => model.isDefault)?.model ||
    models[0]?.model ||
    ""
  );
}

export function notifyAgentStatus(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.state !== "string" || typeof candidate.message !== "string") return;
  if (!["checking", "ready", "missing", "auth_required", "error"].includes(candidate.state)) return;
  currentStatus = candidate as AgentStatus;
  statusListeners.forEach((listener) => listener(currentStatus));
}

export function notifyAgentEvent(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.eventType !== "string") return;
  const data = candidate.data && typeof candidate.data === "object" ? (candidate.data as Record<string, unknown>) : {};
  eventListeners.forEach((listener) => listener({ eventType: candidate.eventType as AgentEvent["eventType"], data }));
}

export function notifyAgentToolRequest(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.callId !== "string" || typeof candidate.tool !== "string") return;
  const callId = candidate.callId;
  const tool = candidate.tool;
  toolListeners.forEach((listener) =>
    listener({
      arguments:
        candidate.arguments && typeof candidate.arguments === "object"
          ? (candidate.arguments as Record<string, unknown>)
          : {},
      callId,
      threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
      tool,
      turnId: typeof candidate.turnId === "string" ? candidate.turnId : "",
    })
  );
}

export function notifyAgentThread(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.threadId !== "string" || !candidate.threadId.trim()) return;
  const threadId = candidate.threadId;
  threadListeners.forEach((listener) =>
    listener({
      threadId,
      resumed: candidate.resumed === true,
      model: typeof candidate.model === "string" ? candidate.model : undefined,
    })
  );
}

export function notifyAgentModels(value: unknown) {
  const candidates = Array.isArray(value) ? value : [];
  const models = candidates.flatMap((value): AgentModel[] => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Record<string, unknown>;
    const model =
      typeof candidate.model === "string" && candidate.model.trim()
        ? candidate.model.trim()
        : typeof candidate.id === "string"
          ? candidate.id.trim()
          : "";
    if (!model) return [];
    return [
      {
        id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : model,
        model,
        displayName:
          typeof candidate.displayName === "string" && candidate.displayName.trim()
            ? candidate.displayName.trim()
            : model,
        defaultReasoningEffort:
          typeof candidate.defaultReasoningEffort === "string" ? candidate.defaultReasoningEffort : undefined,
        isDefault: candidate.isDefault === true,
      },
    ];
  });
  const mainModel = availableModel(models, currentModels.mainModel) || defaultMainModel(models);
  currentModels = { models, mainModel };
  modelListeners.forEach((listener) => listener(currentModels));
}

export function setAgentModelSelection(requested: string) {
  const model = availableModel(currentModels.models, requested);
  if (!model) return;
  currentModels = { ...currentModels, mainModel: model };
  persistModel(MAIN_MODEL_KEY, model);
  modelListeners.forEach((listener) => listener(currentModels));
}

export function subscribeAgentEvents(listener: (event: AgentEvent) => void) {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

export function subscribeAgentToolRequests(listener: (request: AgentToolRequest) => void) {
  toolListeners.add(listener);
  return () => {
    toolListeners.delete(listener);
  };
}

export function subscribeAgentThreads(listener: (thread: AgentThread) => void) {
  threadListeners.add(listener);
  return () => {
    threadListeners.delete(listener);
  };
}

export function useAgentStatus(): AgentStatus {
  const [status, setStatus] = useState(currentStatus);
  useEffect(() => {
    statusListeners.add(setStatus);
    return () => {
      statusListeners.delete(setStatus);
    };
  }, []);
  return status;
}

export function useAgentModels(): AgentModelSelection {
  const [selection, setSelection] = useState(currentModels);
  useEffect(() => {
    modelListeners.add(setSelection);
    return () => {
      modelListeners.delete(setSelection);
    };
  }, []);
  return selection;
}
