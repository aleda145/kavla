import { estimateQuery, type QueryEstimate } from "../client/queryEstimate";
import { quoteDottedIdentifier } from "../src/duckdb/sql";

export function buildBigQuerySampleSQL(tableRef: string, percent: number): string {
  return `SELECT * FROM ${quoteDottedIdentifier(tableRef)} TABLESAMPLE SYSTEM (${percent} PERCENT)`;
}

export function estimateSourceSample(tableRef: string, percent: number): Promise<QueryEstimate> {
  return estimateQuery({
    sql: buildBigQuerySampleSQL(tableRef, percent),
    sourceName: tableRef.split(".")[0],
    sourceType: "bigquery",
    sourceNative: true,
  });
}
