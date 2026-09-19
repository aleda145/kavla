import { useEffect, useState } from "react";
import { useValue, type TLShapeId } from "tldraw";
import { backendRevision } from "./backendCompute";
import { useData } from "./useLocalServer";
import { MissingQueryResultError } from "./localServer/types";
import { getRestoredRemoteQueryMetadata } from "../SQLTextArea/restoreRemoteQueryView";
import { loadQueryResultRows } from "./loadQueryResultRows";

export interface QueryResultRows {
  columns: string[];
  columnTypes: Record<string, string>;
  data: Record<string, unknown>[];
  error: string | null;
  isLoading: boolean;
  isTruncated: boolean;
}

interface UseQueryResultRowsOptions {
  sourceShapeId: TLShapeId | null;
  sourceTableName: string | null;
  schema?: { name: string; type: string }[] | null;
  revision?: unknown;
  limit?: number | null;
  normalizeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  serverResultShapeId?: TLShapeId | null;
  restoreServerResult?: () => Promise<void>;
}

const EMPTY_RESULT: QueryResultRows = {
  columns: [],
  columnTypes: {},
  data: [],
  error: null,
  isLoading: false,
  isTruncated: false,
};

const identityRow = (row: Record<string, unknown>) => row;

export function useQueryResultRows({
  sourceShapeId,
  sourceTableName,
  schema,
  revision,
  limit = null,
  normalizeRow = identityRow,
  serverResultShapeId = null,
  restoreServerResult,
}: UseQueryResultRowsOptions): QueryResultRows {
  const serverRevision = useValue("backend revision", () => backendRevision.get(), []);
  const [result, setResult] = useState<QueryResultRows>(EMPTY_RESULT);
  const { getQueryResultPage } = useData();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    if (!sourceShapeId || !sourceTableName) {
      setResult(EMPTY_RESULT);
      return;
    }

    setResult({
      ...EMPTY_RESULT,
      isLoading: true,
    });

    void (async () => {
      try {
        {
          const resultShapeId = serverResultShapeId ?? sourceShapeId;
          const rowLimit = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : null;
          const loadRows = () =>
            loadQueryResultRows(
              getQueryResultPage,
              resultShapeId,
              rowLimit === null ? null : rowLimit + 1,
              controller.signal
            );
          let loadedRows;
          try {
            loadedRows = await loadRows();
          } catch (error) {
            if (!(error instanceof MissingQueryResultError) || !restoreServerResult) throw error;
            controller.signal.throwIfAborted();
            await restoreServerResult();
            loadedRows = await loadRows();
          }
          const rows = loadedRows.map(normalizeRow);
          const isTruncated = rowLimit !== null && rows.length > rowLimit;
          const resolvedSchema = getRestoredRemoteQueryMetadata(resultShapeId)?.schema ?? schema ?? [];
          if (!cancelled) {
            setResult({
              columns: resolvedSchema.map((column) => column.name),
              columnTypes: Object.fromEntries(resolvedSchema.map((column) => [column.name, column.type])),
              data: rowLimit === null ? rows : rows.slice(0, rowLimit),
              error: null,
              isLoading: false,
              isTruncated,
            });
          }
          return;
        }
      } catch (error) {
        if (!cancelled) {
          setResult({
            ...EMPTY_RESULT,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    serverRevision,
    limit,
    normalizeRow,
    getQueryResultPage,
    revision,
    schema,
    sourceShapeId,
    sourceTableName,
    serverResultShapeId,
    restoreServerResult,
  ]);

  return result;
}
