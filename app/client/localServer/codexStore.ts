import { useEffect, useState } from "react";

export type CodexStatusState = "checking" | "ready" | "missing" | "auth_required" | "error";

export type CodexStatus = {
  state: CodexStatusState;
  message: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  isDefault: boolean;
};

export type CodexModelSelection = {
  models: CodexModel[];
  mainModel: string;
  layoutModel: string;
};

export type CodexEvent = {
  eventType: "layout_started" | "started" | "message_delta" | "tool_started" | "tool_finished" | "completed" | "cancelled" | "error" | "warning";
  data: Record<string, unknown>;
};

export type CodexToolRequest = {
  arguments: Record<string, unknown>;
  callId: string;
  threadId: string;
  tool: string;
  turnId: string;
};

export type CodexThread = {
  threadId: string;
  resumed: boolean;
  model?: string;
};

const statusListeners = new Set<(status: CodexStatus) => void>();
const eventListeners = new Set<(event: CodexEvent) => void>();
const toolListeners = new Set<(request: CodexToolRequest) => void>();
const threadListeners = new Set<(thread: CodexThread) => void>();
const modelListeners = new Set<(selection: CodexModelSelection) => void>();

const MAIN_MODEL_KEY = "kavla.codex.mainModel";
const LAYOUT_MODEL_KEY = "kavla.codex.layoutModel";

let currentStatus: CodexStatus = {
  state: "checking",
  message: "Checking for Codex CLI…",
};

let currentModels: CodexModelSelection = {
  models: [],
  mainModel: "",
  layoutModel: "",
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

function availableModel(models: CodexModel[], requested: string): string {
  return models.find((model) => model.model === requested || model.id === requested)?.model ?? "";
}

function defaultMainModel(models: CodexModel[]): string {
  return availableModel(models, storedModel(MAIN_MODEL_KEY))
    || availableModel(models, "gpt-5.6-sol")
    || models.find((model) => model.isDefault)?.model
    || models[0]?.model
    || "";
}

function defaultLayoutModel(models: CodexModel[], mainModel: string): string {
  return availableModel(models, storedModel(LAYOUT_MODEL_KEY))
    || availableModel(models, "gpt-5.6-terra")
    || mainModel;
}

export function notifyCodexStatus(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.state !== "string" || typeof candidate.message !== "string") return;
  if (!["checking", "ready", "missing", "auth_required", "error"].includes(candidate.state)) return;
  currentStatus = candidate as CodexStatus;
  statusListeners.forEach((listener) => listener(currentStatus));
}

export function notifyCodexEvent(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.eventType !== "string") return;
  const data = candidate.data && typeof candidate.data === "object" ? candidate.data as Record<string, unknown> : {};
  eventListeners.forEach((listener) => listener({ eventType: candidate.eventType as CodexEvent["eventType"], data }));
}

export function notifyCodexToolRequest(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.callId !== "string" || typeof candidate.tool !== "string") return;
  const callId = candidate.callId;
  const tool = candidate.tool;
  toolListeners.forEach((listener) => listener({
    arguments: candidate.arguments && typeof candidate.arguments === "object"
      ? candidate.arguments as Record<string, unknown>
      : {},
    callId,
    threadId: typeof candidate.threadId === "string" ? candidate.threadId : "",
    tool,
    turnId: typeof candidate.turnId === "string" ? candidate.turnId : "",
  }));
}

export function notifyCodexThread(value: unknown) {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.threadId !== "string" || !candidate.threadId.trim()) return;
  const threadId = candidate.threadId;
  threadListeners.forEach((listener) => listener({
    threadId,
    resumed: candidate.resumed === true,
    model: typeof candidate.model === "string" ? candidate.model : undefined,
  }));
}

export function notifyCodexModels(value: unknown) {
  const candidates = Array.isArray(value) ? value : [];
  const models = candidates.flatMap((value): CodexModel[] => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as Record<string, unknown>;
    const model = typeof candidate.model === "string" && candidate.model.trim()
      ? candidate.model.trim()
      : typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!model) return [];
    return [{
      id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : model,
      model,
      displayName: typeof candidate.displayName === "string" && candidate.displayName.trim()
        ? candidate.displayName.trim()
        : model,
      defaultReasoningEffort: typeof candidate.defaultReasoningEffort === "string"
        ? candidate.defaultReasoningEffort
        : undefined,
      isDefault: candidate.isDefault === true,
    }];
  });
  const mainModel = availableModel(models, currentModels.mainModel) || defaultMainModel(models);
  const layoutModel = availableModel(models, currentModels.layoutModel) || defaultLayoutModel(models, mainModel);
  currentModels = { models, mainModel, layoutModel };
  modelListeners.forEach((listener) => listener(currentModels));
}

export function setCodexModelSelection(role: "main" | "layout", requested: string) {
  const model = availableModel(currentModels.models, requested);
  if (!model) return;
  currentModels = role === "main"
    ? { ...currentModels, mainModel: model }
    : { ...currentModels, layoutModel: model };
  persistModel(role === "main" ? MAIN_MODEL_KEY : LAYOUT_MODEL_KEY, model);
  modelListeners.forEach((listener) => listener(currentModels));
}

export function subscribeCodexEvents(listener: (event: CodexEvent) => void) {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function subscribeCodexToolRequests(listener: (request: CodexToolRequest) => void) {
  toolListeners.add(listener);
  return () => { toolListeners.delete(listener); };
}

export function subscribeCodexThreads(listener: (thread: CodexThread) => void) {
  threadListeners.add(listener);
  return () => { threadListeners.delete(listener); };
}

export function useCodexStatus(): CodexStatus {
  const [status, setStatus] = useState(currentStatus);
  useEffect(() => {
    statusListeners.add(setStatus);
    return () => { statusListeners.delete(setStatus); };
  }, []);
  return status;
}

export function useCodexModels(): CodexModelSelection {
  const [selection, setSelection] = useState(currentModels);
  useEffect(() => {
    modelListeners.add(setSelection);
    return () => { modelListeners.delete(setSelection); };
  }, []);
  return selection;
}
