import type * as duckdb from "@duckdb/duckdb-wasm";
import { buildColumnStatsQuery, parseColumnStatsRows } from "./column-stats-sql";
import type { ColumnStats } from "./column-stats-types";
import { quoteIdentifier } from "./sql";

export class DuckDBColumnStats {
  private columnStatsCache: Map<string, ColumnStats> = new Map();

  constructor(private getDb: () => duckdb.AsyncDuckDB | null) {}

  public clearForTable(tableName: string): void {
    for (const cacheKey of Array.from(this.columnStatsCache.keys())) {
      if (cacheKey.startsWith(`${tableName}:`)) {
        this.columnStatsCache.delete(cacheKey);
      }
    }
  }

  public async getAllColumnStats(
    tableName: string,
    metadata: { name: string; type: string }[]
  ): Promise<Record<string, ColumnStats>> {
    const stats: Record<string, ColumnStats> = {};
    for (const col of metadata) {
      try {
        stats[col.name] = (await this.getColumnStats(tableName, col.name, col.type)) ?? {
          type: "other",
          error: "Failed to compute stats",
        };
      } catch (e) {
        console.error(`Failed to compute stats for ${col.name}`, e);
        stats[col.name] = { type: "other", error: "Failed to compute stats" };
      }
    }
    // DuckDB WASM returns BigInt for integer aggregates (COUNT, etc).
    // JSON.stringify can't handle BigInt, so we convert them to Number.
    return JSON.parse(JSON.stringify(stats, (_key, value) => (typeof value === "bigint" ? Number(value) : value)));
  }

  public async getColumnStats(tableName: string, columnName: string, type: string): Promise<ColumnStats | null> {
    const db = this.getDb();
    if (!db) return null;

    const cacheKey = `${tableName}:${columnName}`;
    if (this.columnStatsCache.has(cacheKey)) {
      return this.columnStatsCache.get(cacheKey) ?? null;
    }

    const connection = await db.connect();
    let result: ColumnStats | null = null;

    try {
      const { analysisType, sql } = buildColumnStatsQuery({
        quotedTable: quoteIdentifier(tableName),
        quotedColumn: quoteIdentifier(columnName),
        columnType: type,
      });
      const queryResult = await connection.query(sql);
      const rows = queryResult.toArray().map((row: any) => row.toJSON());
      result = parseColumnStatsRows(analysisType, rows);

      if (result) {
        this.columnStatsCache.set(cacheKey, result);
      }
    } catch (e) {
      console.error(`Failed to compute stats for ${tableName}.${columnName}`, e);
      result = { type: "other", error: "Failed to compute stats" };
    } finally {
      await connection.close();
    }

    return result;
  }
}
