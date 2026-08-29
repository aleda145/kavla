import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEH from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import duckdbWorkerEH from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import { atom } from "tldraw";
import { DuckDBColumnStats } from "./duckdb/column-stats";
import type { ColumnStats } from "./duckdb/column-stats-types";
import { printDuckDBHeap } from "./duckdb/debug";
import { DuckDBMetadata } from "./duckdb/metadata";
import { DuckDBQueryExports } from "./duckdb/query-exports";
import { quoteSqlString } from "./duckdb/sql";
import { DuckDBTableRegistry } from "./duckdb/table-registry";

export const isDuckDBComputing = atom("isDuckDBComputing", false);

export class DuckDBService {
  private static instance: DuckDBService;
  private db: duckdb.AsyncDuckDB | null = null;
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;

  private columnStats = new DuckDBColumnStats(() => this.db);
  private tableRegistry = new DuckDBTableRegistry({
    getDb: () => this.db,
    onReleaseTable: (tableName) => this.columnStats.clearForTable(tableName),
  });
  private metadata = new DuckDBMetadata(() => this.db, this.tableRegistry);
  private queryExports = new DuckDBQueryExports({
    getDb: () => this.db,
  });

  private constructor() {}

  public static getInstance(): DuckDBService {
    if (!DuckDBService.instance) {
      DuckDBService.instance = new DuckDBService();
      if (typeof window !== "undefined") {
        (window as any).duckDB = DuckDBService.instance;
      }
    }
    return DuckDBService.instance;
  }

  public init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (this.db) {
        return;
      }

      try {
        this.worker = new Worker(duckdbWorkerEH);
        this.trackComputingState(this.worker);

        const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.ERROR);
        this.db = new duckdb.AsyncDuckDB(logger, this.worker);
        await this.db.instantiate(duckdbWasmEH);
        await this.loadPackagedExtensions();

        console.log("DuckDB WASM initialized successfully.");
      } catch (err) {
        console.error("Failed to initialize DuckDB WASM:", err);
        this.db = null;
        this.worker = null;
        this.initPromise = null;
        throw err;
      }
    })();

    return this.initPromise;
  }

  public getDb(): duckdb.AsyncDuckDB | null {
    return this.db;
  }

  public async printHeap(): Promise<void> {
    if (!this.db) {
      console.log("DuckDB not initialized.");
      return;
    }

    return printDuckDBHeap({
      db: this.db,
      getLoadedUrlsSnapshot: () => this.tableRegistry.getLoadedUrlsSnapshot(),
      getMetadataCacheSnapshot: () => this.metadata.getMetadataCacheSnapshot(),
    });
  }

  public async registerFile(tableName: string, file: File): Promise<void> {
    return this.tableRegistry.registerFile(tableName, file);
  }

  public getRegisteredFile(tableName: string): File | null {
    return this.tableRegistry.getRegisteredFile(tableName);
  }

  public async registerArrowIPC(tableName: string, buffer: Uint8Array): Promise<void> {
    await this.tableRegistry.releaseTable(tableName);
    return this.tableRegistry.registerArrowIPC(tableName, buffer);
  }

  public isTableLoaded(tableName: string): boolean {
    return this.tableRegistry.isTableLoaded(tableName);
  }

  public async releaseTable(tableName: string): Promise<void> {
    return this.tableRegistry.releaseTable(tableName);
  }

  public async createQueryView(sql: string, outputTableName: string): Promise<void> {
    await this.tableRegistry.releaseTable(outputTableName);
    await this.queryExports.createQueryView(sql, outputTableName);
    this.tableRegistry.markInMemoryView(outputTableName);
  }

  public async runQueryView(
    sql: string,
    outputTableName: string
  ): Promise<{
    rowCount: number;
    schema: { name: string; type: string }[];
    sampleRows: Record<string, unknown>[];
  }> {
    await this.createQueryView(sql, outputTableName);
    return this.queryExports.inspectQueryView(outputTableName);
  }

  public async convertTableToParquet(tableName: string): Promise<Uint8Array> {
    return this.queryExports.convertTableToParquet(tableName);
  }

  public async convertTableToCSV(tableName: string): Promise<Uint8Array> {
    return this.queryExports.convertTableToCSV(tableName);
  }

  public async exportQueryToCSV(sql: string): Promise<string> {
    return this.queryExports.exportQueryToCSV(sql);
  }

  public async exportQueryToTSV(sql: string): Promise<string> {
    return this.queryExports.exportQueryToTSV(sql);
  }

  public async validateQuery(sql: string): Promise<string | null> {
    return this.queryExports.validateQuery(sql);
  }

  public async getFileMetadata(
    url: string,
    tableName?: string,
    filename?: string
  ): Promise<{ schema: any[]; count: number }> {
    return this.metadata.getFileMetadata(url, tableName, filename);
  }

  public async loadDataFromUrl(tableName: string, url: string, filename: string): Promise<void> {
    return this.tableRegistry.loadDataFromUrl(tableName, url, filename);
  }

  public async registerRemoteFileUrl(tableName: string, url: string, filename: string): Promise<void> {
    return this.tableRegistry.registerRemoteFileUrl(tableName, url, filename);
  }

  public async getAllColumnStats(
    tableName: string,
    metadata: { name: string; type: string }[]
  ): Promise<Record<string, ColumnStats>> {
    return this.columnStats.getAllColumnStats(tableName, metadata);
  }

  public async getColumnStats(tableName: string, columnName: string, type: string): Promise<ColumnStats | null> {
    return this.columnStats.getColumnStats(tableName, columnName, type);
  }

  private async loadPackagedExtensions(): Promise<void> {
    if (!this.db) {
      throw new Error("DuckDB is unavailable while loading packaged extensions.");
    }

    const extensionRepository = new URL("/duckdb-extensions", window.location.origin).toString().replace(/\/$/, "");
    const connection = await this.db.connect();
    try {
      await connection.query(`SET custom_extension_repository = ${quoteSqlString(extensionRepository)}`);
      await connection.query(`SET autoinstall_extension_repository = ${quoteSqlString(extensionRepository)}`);
      await connection.query("SET allow_community_extensions = false");
      await connection.query("LOAD parquet");
      await connection.query("LOAD json");
    } finally {
      await connection.close();
    }
  }

  private trackComputingState(worker: Worker): void {
    const pendingRequestIds = new Set<number>();
    const originalPostMessage = worker.postMessage.bind(worker);
    worker.postMessage = (message: any, options?: any) => {
      const requestId = message?.messageId;
      if (typeof requestId === "number") {
        pendingRequestIds.add(requestId);
      }
      if (pendingRequestIds.size === 1) {
        isDuckDBComputing.set(true);
      }
      originalPostMessage(message, options);
    };

    worker.addEventListener("message", (event: MessageEvent) => {
      const requestId = event.data?.requestId;
      if (typeof requestId === "number") {
        pendingRequestIds.delete(requestId);
      }
      if (pendingRequestIds.size === 0) {
        isDuckDBComputing.set(false);
      }
    });

    worker.addEventListener("error", () => {
      pendingRequestIds.clear();
      isDuckDBComputing.set(false);
    });
  }
}
