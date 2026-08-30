import { buildColumnStatsQuery, parseColumnStatsRows } from "../src/duckdb/column-stats-sql";
import type { ColumnStats } from "../src/duckdb/column-stats-types";
import { quoteDottedIdentifier, quoteIdentifier } from "../src/duckdb/sql";

export type RunRemoteQueryFn = (payload: {
  sql: string;
  sourceName: string;
  sourceType?: string | null;
  shapeId: string;
  sourceNative?: boolean;
  transient?: boolean;
}) => Promise<{
  rowCount: number;
  schema: { name: string; type: string }[];
  sampleRows: Record<string, unknown>[];
}>;

export type CancelRemoteQueryFn = (shapeId: string, queryName?: string) => void;

export interface RemoteSourceInfo {
  sourceName: string;
  sourceType?: string | null;
  fullTableRef: string;
  tableSql?: string;
  runRemoteQuery: RunRemoteQueryFn;
  cancelRemoteQuery: CancelRemoteQueryFn;
}

async function runRemoteAndParse(
  runRemoteQuery: RunRemoteQueryFn,
  sourceName: string,
  sourceType: string | null | undefined,
  sql: string,
  requestShapeId: string
): Promise<any[]> {
  const { sampleRows } = await runRemoteQuery({
    sql,
    sourceName,
    sourceType,
    shapeId: requestShapeId,
    sourceNative: true,
    transient: true,
  });

  return sampleRows;
}

const remoteStatsCache = new Map<string, ColumnStats>();
const remoteStatsInFlight = new Map<string, Promise<ColumnStats>>();

function getRemoteStatsCacheKey(sourceName: string, fullTableRef: string, columnName: string) {
  return `${sourceName}:${fullTableRef}:${columnName}`;
}

export function getExistingRemoteColumnStats(
  sourceName: string | null | undefined,
  fullTableRef: string | null | undefined,
  columnName: string
): ColumnStats | null {
  if (!sourceName || !fullTableRef) {
    return null;
  }

  const cacheKey = getRemoteStatsCacheKey(sourceName, fullTableRef, columnName);
  return remoteStatsCache.get(cacheKey) ?? null;
}

export function invalidateRemoteColumnStats(
  sourceName: string | null | undefined,
  fullTableRef: string | null | undefined,
  columnName: string
) {
  if (!sourceName || !fullTableRef) {
    return;
  }

  const cacheKey = getRemoteStatsCacheKey(sourceName, fullTableRef, columnName);
  remoteStatsCache.delete(cacheKey);
  remoteStatsInFlight.delete(cacheKey);
}

export function getCachedRemoteColumnStats(
  runRemoteQuery: RunRemoteQueryFn,
  sourceName: string,
  sourceType: string | null | undefined,
  fullTableRef: string,
  columnName: string,
  colType: string,
  requestShapeId: string,
  tableSql?: string
): Promise<ColumnStats> {
  const cacheKey = getRemoteStatsCacheKey(sourceName, fullTableRef, columnName);

  const cached = remoteStatsCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  const inFlight = remoteStatsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = getRemoteColumnStats(
    runRemoteQuery,
    sourceName,
    sourceType,
    fullTableRef,
    columnName,
    colType,
    requestShapeId,
    tableSql
  )
    .then((result) => {
      remoteStatsCache.set(cacheKey, result);
      remoteStatsInFlight.delete(cacheKey);
      return result;
    })
    .catch((err) => {
      remoteStatsInFlight.delete(cacheKey);
      throw err;
    });

  remoteStatsInFlight.set(cacheKey, promise);
  return promise;
}

async function getRemoteColumnStats(
  runRemoteQuery: RunRemoteQueryFn,
  sourceName: string,
  sourceType: string | null | undefined,
  fullTableRef: string,
  columnName: string,
  colType: string,
  requestShapeId: string,
  tableSql?: string
): Promise<ColumnStats> {
  const quotedCol = quoteIdentifier(columnName);
  const quotedTable = tableSql ? `(${tableSql.replace(/;+\s*$/, "")})` : quoteDottedIdentifier(fullTableRef);
  const { analysisType, sql } = buildColumnStatsQuery({
    quotedTable,
    quotedColumn: quotedCol,
    columnType: colType,
    sourceType,
  });
  const rows = await runRemoteAndParse(runRemoteQuery, sourceName, sourceType, sql, requestShapeId);
  return parseColumnStatsRows(analysisType, rows);
}
