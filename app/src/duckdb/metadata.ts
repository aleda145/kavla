import * as duckdb from "@duckdb/duckdb-wasm";
import { getReadFunction, quoteSqlString } from "./sql";
import type { DuckDBTableRegistry } from "./table-registry";

export class DuckDBMetadata {
  private metadataCache: Map<string, { schema: any[]; count: number }> = new Map();

  constructor(
    private getDb: () => duckdb.AsyncDuckDB | null,
    private tableRegistry: DuckDBTableRegistry
  ) {}

  public getMetadataCacheSnapshot(): [string, { schema: any[]; count: number }][] {
    return Array.from(this.metadataCache.entries());
  }

  public async getFileMetadata(
    url: string,
    tableName?: string,
    filename?: string
  ): Promise<{ schema: any[]; count: number }> {
    const db = this.getDb();
    if (!db) {
      throw new Error("DuckDB not initialized. Call init() first.");
    }

    if (this.metadataCache.has(url)) {
      return this.metadataCache.get(url)!;
    }

    if (tableName) {
      const loadedTableMetadata = await this.tableRegistry.getMetadataForLoadedTable(tableName);
      if (loadedTableMetadata) {
        this.metadataCache.set(url, loadedTableMetadata);
        return loadedTableMetadata;
      }
    }

    if (!filename) {
      throw new Error("getFileMetadata requires a filename when the file is not already loaded.");
    }

    const tempRegisteredFile = `metadata_${Date.now()}.${filename.split(".").pop()}`;
    await db.registerFileURL(tempRegisteredFile, url, duckdb.DuckDBDataProtocol.HTTP, false);

    const readFunc = getReadFunction(filename);
    const connection = await db.connect();
    try {
      const schemaResult = await connection.query(
        `DESCRIBE SELECT * FROM ${readFunc}(${quoteSqlString(tempRegisteredFile)})`
      );
      const countResult = await connection.query(
        `SELECT COUNT(*) as count FROM ${readFunc}(${quoteSqlString(tempRegisteredFile)})`
      );

      const schema = schemaResult.toArray().map((row: any) => row.toJSON());
      const count = countResult.toArray()[0].toJSON().count as number;
      const result = {
        schema: schema.map((s: any) => ({
          name: s.column_name,
          type: s.column_type,
        })),
        count: Number(count),
      };

      this.metadataCache.set(url, result);
      return result;
    } finally {
      await connection.close();
      await db.dropFile(tempRegisteredFile).catch(() => undefined);
    }
  }
}
