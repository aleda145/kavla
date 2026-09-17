import { notifyAgentAuth } from "./agentAuth";
import { notifyAgentRuns, agentClientId, getAgentRuns, isAgentRunActive, cancelAgentRun } from "./agentRuns";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { tableFromIPC } from "apache-arrow";
import { getActiveLocalSession } from "../local/localSession";
import {
  notifyAgentEvent,
  notifyAgentModels,
  notifyAgentStatus,
  notifyAgentThread,
  notifyAgentToolRequest,
} from "./agentStore";
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
      notifyAgentStatus({ state: "missing", message: "Run Kavla through the CLI or desktop app to use the Agent." });
      notifyAgentModels([]);
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
      notifyAgentStatus({ state: "error", message: "The Kavla server connection is disconnected. Reconnecting…" });
    };

    const receiveEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as { stream: "cli" | "agent"; name: string; data: unknown };
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
      } else if (event.stream === "agent") {
        switch (event.name) {
          case "snapshot": {
            const snapshot = event.data as { status?: unknown; models?: unknown; runs?: unknown; auth?: unknown };
            notifyAgentStatus(snapshot.status);
            notifyAgentModels(snapshot.models);
            notifyAgentRuns(snapshot.runs);
            notifyAgentAuth(snapshot.auth);
            break;
          }
          case "auth":
            notifyAgentAuth(event.data);
            break;
          case "runs":
            notifyAgentRuns(event.data);
            break;
          case "status":
            notifyAgentStatus(event.data);
            break;
          case "models":
            notifyAgentModels(event.data);
            break;
          case "event":
            notifyAgentEvent(event.data);
            break;
          case "tool_request":
            notifyAgentToolRequest(event.data);
            break;
          case "thread":
            notifyAgentThread(event.data);
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
    async ({ shapeId, offset, limit, signal }) => {
      const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      const response = await fetch(`/api/session/queries/${encodeURIComponent(shapeId)}/rows?${query.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/vnd.apache.arrow.stream" },
        signal,
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

  const reportAgentRequestError = useCallback((error: unknown) => {
    notifyAgentEvent({
      eventType: "error",
      data: { message: error instanceof Error ? error.message : String(error) },
    });
  }, []);

  const sendAgentPrompt = useCallback<LocalServerContextType["sendAgentPrompt"]>(
    (payload) => {
      void postJSON("/api/agent/prompts", { ...payload, clientId: agentClientId, documentId: getActiveLocalSession()?.documentId }).catch(reportAgentRequestError);
    },
    [reportAgentRequestError]
  );

  const sendAgentToolResult = useCallback<LocalServerContextType["sendAgentToolResult"]>(
    (payload) => {
      void postJSON("/api/agent/tool-results", { ...payload, clientId: agentClientId }).catch(reportAgentRequestError);
    },
    [reportAgentRequestError]
  );

  const cancelAgent = useCallback<LocalServerContextType["cancelAgent"]>(() => {
    const run = getAgentRuns().find(isAgentRunActive);
    if (run) void cancelAgentRun(run.id).catch(reportAgentRequestError);
  }, [reportAgentRequestError]);

  const retryAgent = useCallback<LocalServerContextType["retryAgent"]>(() => {
    notifyAgentStatus({ state: "checking", message: "Preparing Agent connection…" });
    void postJSON("/api/agent/retry", {}).catch(reportAgentRequestError);
  }, [reportAgentRequestError]);

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
      sendAgentPrompt,
      sendAgentToolResult,
      cancelAgent,
      retryAgent,
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
      sendAgentPrompt,
      sendAgentToolResult,
      cancelAgent,
      retryAgent,
    ]
  );

  return <LocalServerContext.Provider value={context}>{children}</LocalServerContext.Provider>;
}
