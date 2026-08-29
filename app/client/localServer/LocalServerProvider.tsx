import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { tableFromIPC } from "apache-arrow";
import { getActiveLocalSession } from "../local/localSession";
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
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function LocalServerProvider({ children }: { children: ReactNode }) {
  const queryControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    if (!getActiveLocalSession()) {
      notifyCliStatus(false);
      notifyCliSources([]);
      return;
    }

    const events = new EventSource("/api/cli/events");
    events.onopen = () => notifyCliStatus(true);
    events.onerror = () => notifyCliStatus(false);
    events.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse((event as MessageEvent<string>).data) as {
        sources?: unknown[];
        output?: CliOutputLine[];
      };
      notifyCliSources(snapshot.sources ?? []);
      notifyCliOutputHistory(snapshot.output ?? []);
    });
    events.addEventListener("sources", (event) => {
      notifyCliSources(JSON.parse((event as MessageEvent<string>).data) as unknown[]);
    });
    events.addEventListener("output", (event) => {
      notifyCliOutputLine(JSON.parse((event as MessageEvent<string>).data) as CliOutputLine);
    });

    return () => {
      events.close();
      notifyCliStatus(false);
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
    ]
  );

  return <LocalServerContext.Provider value={context}>{children}</LocalServerContext.Provider>;
}
