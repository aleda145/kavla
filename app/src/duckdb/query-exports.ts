import type * as duckdb from "@duckdb/duckdb-wasm";
import { quoteIdentifier, stripTrailingSemicolons, quoteSqlString } from "./sql";

interface DuckDBQueryExportsOptions {
  getDb: () => duckdb.AsyncDuckDB | null;
}

export class DuckDBQueryExports {
  constructor(private options: DuckDBQueryExportsOptions) {}

  public async createQueryView(sql: string, outputTableName: string): Promise<void> {
    const db = this.getDbOrThrow();
    const querySql = stripTrailingSemicolons(sql);
    const connection = await db.connect();
    try {
      await connection.query(`CREATE OR REPLACE VIEW ${quoteIdentifier(outputTableName)} AS ${querySql}`);
    } finally {
      await connection.close();
    }
  }

  public async inspectQueryView(outputTableName: string): Promise<{
    rowCount: number;
    schema: { name: string; type: string }[];
    sampleRows: Record<string, unknown>[];
  }> {
    const db = this.getDbOrThrow();
    const quotedOutputTable = quoteIdentifier(outputTableName);
    const connection = await db.connect();
    try {
      const schemaResult = await connection.query(`DESCRIBE SELECT * FROM ${quotedOutputTable}`);
      const schema = schemaResult.toArray().map((row: any) => {
        const value = row.toJSON();
        return {
          name: value.column_name,
          type: value.column_type,
        };
      });

      const countResult = await connection.query(`SELECT COUNT(*) as count FROM ${quotedOutputTable}`);
      const rowCount = Number(countResult.toArray()[0].toJSON().count);

      const sampleResult = await connection.query(`SELECT * FROM ${quotedOutputTable} LIMIT 5`);
      const sampleRows = sampleResult.toArray().map((row: any) => row.toJSON() as Record<string, unknown>);

      return { rowCount, schema, sampleRows };
    } finally {
      await connection.close();
    }
  }

  public async convertTableToParquet(tableName: string): Promise<Uint8Array> {
    const db = this.getDbOrThrow("DuckDB not initialized");
    const connection = await db.connect();
    const fileName = `convert_${Date.now()}_${crypto.randomUUID()}.parquet`;

    try {
      await connection.query(`COPY (SELECT * FROM "${tableName}") TO '${fileName}' (FORMAT 'PARQUET', CODEC 'SNAPPY')`);
      return await db.copyFileToBuffer(fileName);
    } finally {
      await db.dropFile(fileName).catch(() => undefined);
      await connection.close();
    }
  }

  public async convertTableToCSV(tableName: string): Promise<Uint8Array> {
    const db = this.getDbOrThrow("DuckDB not initialized");
    const connection = await db.connect();
    const fileName = `convert_${Date.now()}_${crypto.randomUUID()}.csv`;

    try {
      await connection.query(`COPY (SELECT * FROM "${tableName}") TO '${fileName}' (HEADER, DELIMITER ',')`);
      return await db.copyFileToBuffer(fileName);
    } finally {
      await db.dropFile(fileName).catch(() => undefined);
      await connection.close();
    }
  }

  public async exportQueryToCSV(sql: string): Promise<string> {
    return this.exportQueryToText(sql, "csv", "HEADER, DELIMITER ','");
  }

  public async exportQueryToTSV(sql: string): Promise<string> {
    return this.exportQueryToText(sql, "tsv", "HEADER, DELIMITER '\\t'");
  }

  public async validateQuery(sql: string): Promise<string | null> {
    const db = this.options.getDb();
    if (!db) return "DuckDB not initialized";
    const connection = await db.connect();
    try {
      await connection.query(`PREPARE v1 AS ${sql}`);
      await connection.query("DEALLOCATE v1");
      return null;
    } catch (e: any) {
      return e.message.replace(/PREPARE v1 AS /g, "");
    } finally {
      await connection.close();
    }
  }

  private async exportQueryToText(sql: string, extension: "csv" | "tsv", copyOptions: string): Promise<string> {
    const db = this.getDbOrThrow();
    const connection = await db.connect();
    const tempTableName = `__result_${extension}_${Date.now()}_${crypto.randomUUID().replace(/-/g, "_")}`;
    const fileName = `output_${Date.now()}_${crypto.randomUUID()}.${extension}`;

    try {
      await connection.query(`CREATE TEMP TABLE ${tempTableName} AS ${sql}`);
      await connection.query(`COPY ${tempTableName} TO ${quoteSqlString(fileName)} (${copyOptions})`);

      const buffer = await db.copyFileToBuffer(fileName);
      const decoder = new TextDecoder();
      return decoder.decode(buffer);
    } finally {
      await db.dropFile(fileName).catch(() => undefined);
      await connection.query(`DROP TABLE IF EXISTS ${tempTableName}`).catch(() => undefined);
      await connection.close();
    }
  }

  private getDbOrThrow(message = "DuckDB not initialized. Call init() first."): duckdb.AsyncDuckDB {
    const db = this.options.getDb();
    if (!db) {
      throw new Error(message);
    }
    return db;
  }
}
