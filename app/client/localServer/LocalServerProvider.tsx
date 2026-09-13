import { notifyCodexAuth } from "./codexAuth";
import { notifyCodexRuns, codexClientId, getCodexRuns, isCodexRunActive, cancelCodexRun } from "./codexRuns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { tableFromIPC } from "apache-arrow";
import { getActiveLocalSession } from "../local/localSession";
import {
  notifyCodexEvent,
  notifyCodexModels,
  notifyCodexStatus,
  notifyCodexThread,
  notifyCodexToolRequest,
} from "./codexStore";
import {
  notifyCliOutputHistory,
  notifyCliOutputLine,
  notifyCliSources,
  notifyCliStatus,
  transpileRemoteSQL,
  updateCliSourceStatus,
  type CliOutputLine,
} from "./runtimeStore";
import { MissingQueryResultError, type LocalServerContextType, type RunRemoteQueryPayload } from "./types";

const LocalServerContext = createContext<LocalServerContextType | null>(null);

export function useLocalServer(): LocalServerContextType {
  const context = useContext(LocalServerContext);
  if (!context) throw new Error("useLocalServer must be used within LocalServerProvider");
  return context;
}

async function responseError(response: Response): Promise<Error> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const message = (await response.text()).trim();
  if (contentType.includes("application/json") && message) {
    try {
      const body = JSON.parse(message) as { error?: unknown };
      if (typeof body.error === "string" && body.error.trim()) return new Error(body.error);
    } catch {
      // Fall through to the response body below.
    }
  }
  return new Error(message || `Kavla server request failed with status ${response.status}`);
}

async function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204 || response.status === 202) return undefined as T;
  return (await response.json()) as T;
}

export function LocalServerProvider({ children }: { children: ReactNode }) {
  const queryControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    if (!getActiveLocalSession()) {
      notifyCliStatus(false);
      notifyCliSources([]);
      notifyCodexStatus({ state: "missing", message: "Run Kavla through the CLI or desktop app to use the Agent." });
      notifyCodexModels([]);
      return;
    }

    const url = new URL("/api/runtime/events", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let connectTimer: number | undefined;
    let reconnectDelay = 1000;
    let stopped = false;

    const disconnected = () => {
      notifyCliStatus(false);
      notifyCodexStatus({ state: "error", message: "The Kavla server connection is disconnected. Reconnecting…" });
    };

    const receiveEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as { stream: "cli" | "codex"; name: string; data: unknown };
      if (event.stream === "cli") {
        switch (event.name) {
          case "snapshot": {
            const snapshot = event.data as { sources?: unknown[]; output?: CliOutputLine[] };
            notifyCliSources(snapshot.sources ?? []);
            notifyCliOutputHistory(snapshot.output ?? []);
            notifyCliStatus(true);
            break;
          }
          case "sources":
            notifyCliSources(event.data as unknown[]);
            break;
          case "output":
            notifyCliOutputLine(event.data as CliOutputLine);
            break;
        }
      } else if (event.stream === "codex") {
        switch (event.name) {
          case "snapshot": {
            const snapshot = event.data as { status?: unknown; models?: unknown; runs?: unknown; auth?: unknown };
            notifyCodexStatus(snapshot.status);
            notifyCodexModels(snapshot.models);
            notifyCodexRuns(snapshot.runs);
            notifyCodexAuth(snapshot.auth);
            break;
          }
          case "auth":
            notifyCodexAuth(event.data);
            break;
          case "runs":
            notifyCodexRuns(event.data);
            break;
          case "status":
            notifyCodexStatus(event.data);
            break;
          case "models":
            notifyCodexModels(event.data);
            break;
          case "event":
            notifyCodexEvent(event.data);
            break;
          case "tool_request":
            notifyCodexToolRequest(event.data);
            break;
          case "thread":
            notifyCodexThread(event.data);
            break;
        }
      }
    };

    const connect = () => {
      if (stopped || socket) return;
      const connection = new WebSocket(url);
      socket = connection;
      connectTimer = window.setTimeout(() => connection.close(), 10000);
      connection.onopen = () => {
        window.clearTimeout(connectTimer);
        reconnectDelay = 1000;
      };
      connection.onmessage = receiveEvent;
      connection.onerror = disconnected;
      connection.onclose = () => {
        window.clearTimeout(connectTimer);
        socket = null;
        if (stopped) return;
        disconnected();
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      };
    };

    const disconnect = () => {
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(connectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      notifyCliStatus(false);
    };
    const onPageHide = () => {
      stopped = true;
      disconnect();
    };
    const onPageShow = () => {
      stopped = false;
      connect();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    connect();

    return () => {
      stopped = true;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      disconnect();
    };
  }, []);

  const getSourceTables = useCallback<LocalServerContextType["getSourceTables"]>(async ({ sourceName }) => {
    const response = await fetch(`/api/cli/sources/${encodeURIComponent(sourceName)}/tables`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const error = await responseError(response);
      updateCliSourceStatus(sourceName, { available: false, error: error.message });
      throw error;
    }
    updateCliSourceStatus(sourceName, { available: true, error: undefined });
    return (await response.json()) as { tables: string[] };
  }, []);

  const getSourceSchema = useCallback<LocalServerContextType["getSourceSchema"]>(
    (payload) => postJSON("/api/cli/source-schema", payload),
    []
  );
  const getSourceStats = useCallback<LocalServerContextType["getSourceStats"]>(
    (payload) => postJSON("/api/cli/source-stats", payload),
    []
  );
  const prepareSourceDownload = useCallback<LocalServerContextType["prepareSourceDownload"]>(
    (payload) => postJSON("/api/cli/source-export", payload),
    []
  );
  const prepareQueryResultDownload = useCallback<LocalServerContextType["prepareQueryResultDownload"]>(
    async ({ shapeId, ...payload }) => {
      const response = await fetch(`/api/session/queries/${encodeURIComponent(shapeId)}/export`, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.status === 404) throw new MissingQueryResultError();
      if (!response.ok) throw await responseError(response);
      return (await response.json()) as { downloadUrl: string; fileName: string };
    },
    []
  );

  const getQueryResultPage = useCallback<LocalServerContextType["getQueryResultPage"]>(
    async ({ shapeId, offset, limit }) => {
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      const response = await fetch(`/api/session/queries/${encodeURIComponent(shapeId)}/rows?${query.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/vnd.apache.arrow.stream" },
      });
      if (response.status === 404) throw new MissingQueryResultError();
      if (!response.ok) throw await responseError(response);
      const table = tableFromIPC(new Uint8Array(await response.arrayBuffer()));
      return { rows: table.toArray().map((row) => row.toJSON() as Record<string, unknown>) };
    },
    []
  );

  const runRemoteQuery = useCallback(
    async (payload: RunRemoteQueryPayload) => {
      const executionEngine = payload.sourceNative ? payload.sourceType?.trim() || undefined : undefined;
      if (executionEngine && !payload.sourceName) throw new Error("sourceName is required for source-native preview");
      const sql = executionEngine ? transpileRemoteSQL(payload.sql, payload.sourceName!, executionEngine) : payload.sql;

      queryControllers.current.get(payload.shapeId)?.abort();
      const controller = new AbortController();
      queryControllers.current.set(payload.shapeId, controller);

      try {
        const result = await postJSON<{
          rowCount: number;
          schema: { name: string; type: string }[];
        }>(
          "/api/session/queries",
          { ...payload, sql, ...(executionEngine ? { executionEngine } : {}) },
          controller.signal
        );
        const sample = await getQueryResultPage({ shapeId: payload.shapeId, offset: 0, limit: 5 });
        return {
          rowCount: Number(result.rowCount ?? 0),
          schema: result.schema,
          sampleRows: sample.rows,
        };
      } finally {
        if (payload.transient) {
          await fetch(`/api/session/queries/${encodeURIComponent(payload.shapeId)}/result`, {
            method: "DELETE",
            credentials: "same-origin",
          }).catch(() => undefined);
        }
        if (queryControllers.current.get(payload.shapeId) === controller)
          queryControllers.current.delete(payload.shapeId);
      }
    },
    [getQueryResultPage]
  );

  const cancelRemoteQuery = useCallback((shapeId: string) => {
    queryControllers.current.get(shapeId)?.abort();
    queryControllers.current.delete(shapeId);
    void fetch(`/api/session/queries/${encodeURIComponent(shapeId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => undefined);
  }, []);

  const deleteShapes = useCallback<LocalServerContextType["deleteShapes"]>((shapeIds) => {
    void postJSON("/api/session/blobs/delete-for-shapes", { shapeIds }).catch((error) => {
      console.error("Could not delete shape blobs", error);
    });
  }, []);

  const reportCodexRequestError = useCallback((error: unknown) => {
    notifyCodexEvent({
      eventType: "error",
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }, []);

  const sendCodexPrompt = useCallback<LocalServerContextType["sendCodexPrompt"]>(
    (payload) => {
      void postJSON("/api/codex/prompts", { ...payload, clientId: codexClientId, documentId: getActiveLocalSession()?.documentId }).catch(reportCodexRequestError);
    },
    [reportCodexRequestError]
  );

  const sendCodexToolResult = useCallback<LocalServerContextType["sendCodexToolResult"]>(
    (payload) => {
      void postJSON("/api/codex/tool-results", { ...payload, clientId: codexClientId }).catch(reportCodexRequestError);
    },
    [reportCodexRequestError]
  );

  const cancelCodex = useCallback<LocalServerContextType["cancelCodex"]>(() => {
    const run = getCodexRuns().find(isCodexRunActive);
    if (run) void cancelCodexRun(run.id).catch(reportCodexRequestError);
  }, [reportCodexRequestError]);

  const retryCodex = useCallback<LocalServerContextType["retryCodex"]>(() => {
    notifyCodexStatus({ state: "checking", message: "Preparing Agent connection…" });
    void postJSON("/api/codex/retry", {}).catch(reportCodexRequestError);
  }, [reportCodexRequestError]);

  const context = useMemo<LocalServerContextType>(
    () => ({
      updateSourceName: () => undefined,
      deleteShapes,
      getSourceTables,
      getSourceSchema,
      getSourceStats,
      prepareSourceDownload,
      prepareQueryResultDownload,
      getQueryResultPage,
      runRemoteQuery,
      cancelRemoteQuery,
      sendCodexPrompt,
      sendCodexToolResult,
      cancelCodex,
      retryCodex,
    }),
    [
      cancelRemoteQuery,
      deleteShapes,
      getQueryResultPage,
      getSourceSchema,
      getSourceStats,
      getSourceTables,
      prepareQueryResultDownload,
      prepareSourceDownload,
      runRemoteQuery,
      sendCodexPrompt,
      sendCodexToolResult,
      cancelCodex,
      retryCodex,
    ]
  );

  return <LocalServerContext.Provider value={context}>{children}</LocalServerContext.Provider>;
}
