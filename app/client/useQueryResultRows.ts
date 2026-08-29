import { useEffect, useState } from "react";
import type { TLShapeId } from "tldraw";
import { DuckDBService } from "@/duckdb-service";
import { quoteIdentifier } from "../src/duckdb/sql";
import { useData } from "./useLocalServer";
import { MissingQueryResultError } from "./localServer/types";
import { getRestoredRemoteQueryMetadata } from "../SQLTextArea/restoreRemoteQueryView";

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
  ensureSourceTable?: () => Promise<void>;
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
  ensureSourceTable,
  restoreServerResult,
}: UseQueryResultRowsOptions): QueryResultRows {
  const [result, setResult] = useState<QueryResultRows>(EMPTY_RESULT);
  const { getQueryResultPage } = useData();

  useEffect(() => {
    let cancelled = false;
    if (!sourceShapeId || !sourceTableName) {
      setResult(EMPTY_RESULT);
      return;
    }

    setResult({
      ...EMPTY_RESULT,
      isLoading: true,
    });

    void (async () => {
      const duckDBService = DuckDBService.getInstance();

      try {
        if (serverResultShapeId) {
          const rowLimit = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : 10000;
          const pageRequest = { shapeId: serverResultShapeId, offset: 0, limit: rowLimit + 1 };
          let page;
          try {
            page = await getQueryResultPage(pageRequest);
          } catch (error) {
            if (!(error instanceof MissingQueryResultError) || !restoreServerResult) throw error;
            await restoreServerResult();
            page = await getQueryResultPage(pageRequest);
          }
          const rows = page.rows.map(normalizeRow);
          const isTruncated = rows.length > rowLimit;
          const resolvedSchema = getRestoredRemoteQueryMetadata(serverResultShapeId)?.schema ?? schema ?? [];
          if (!cancelled) {
            setResult({
              columns: resolvedSchema.map((column) => column.name),
              columnTypes: Object.fromEntries(resolvedSchema.map((column) => [column.name, column.type])),
              data: rows.slice(0, rowLimit),
              error: null,
              isLoading: false,
              isTruncated,
            });
          }
          return;
        }

        await duckDBService.init();
        if (!duckDBService.isTableLoaded(sourceTableName)) {
          if (!ensureSourceTable) {
            if (!cancelled) setResult(EMPTY_RESULT);
            return;
          }
          await ensureSourceTable();
        }

        const db = duckDBService.getDb();
        if (!db) {
          throw new Error("DuckDB is not initialized.");
        }

        const connection = await db.connect();
        try {
          const quotedTableName = quoteIdentifier(sourceTableName);
          const resolvedSchema =
            schema && schema.length > 0
              ? schema
              : (await connection.query(`DESCRIBE SELECT * FROM ${quotedTableName}`)).toArray().map((row: any) => {
                  const value = row.toJSON();
                  return { name: String(value.column_name), type: String(value.column_type) };
                });
          const rowLimit = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : null;
          const queryLimit = rowLimit === null ? "" : ` LIMIT ${rowLimit + 1}`;
          const rows = (await connection.query(`SELECT * FROM ${quotedTableName}${queryLimit}`))
            .toArray()
            .map((row: any) => normalizeRow(row.toJSON() as Record<string, unknown>));
          const isTruncated = rowLimit !== null && rows.length > rowLimit;

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
        } finally {
          await connection.close();
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
    };
  }, [
    limit,
    normalizeRow,
    getQueryResultPage,
    revision,
    schema,
    sourceShapeId,
    sourceTableName,
    serverResultShapeId,
    ensureSourceTable,
    restoreServerResult,
  ]);

  return result;
}
