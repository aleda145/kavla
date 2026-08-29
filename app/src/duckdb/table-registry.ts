import * as duckdb from "@duckdb/duckdb-wasm";
import { tableFromIPC } from "apache-arrow";
import { getReadFunction, quoteIdentifier, quoteSqlString } from "./sql";

interface DuckDBTableRegistryOptions {
  getDb: () => duckdb.AsyncDuckDB | null;
  onReleaseTable?: (tableName: string) => void;
}

export class DuckDBTableRegistry {
  private loadedUrls: Map<string, string> = new Map();
  private originalFiles: Map<string, File> = new Map();
  private registeredFiles: Map<string, string> = new Map();
  private tableRegistrations: Map<string, Promise<void>> = new Map();

  constructor(private options: DuckDBTableRegistryOptions) {}

  public getLoadedUrlsSnapshot(): [string, string][] {
    return Array.from(this.loadedUrls.entries());
  }

  public isTableLoaded(tableName: string): boolean {
    return this.loadedUrls.has(tableName);
  }

  public getRegisteredFile(tableName: string): File | null {
    return this.originalFiles.get(tableName) ?? null;
  }

  public markInMemoryTable(tableName: string): void {
    this.originalFiles.delete(tableName);
    this.loadedUrls.set(tableName, "IN_MEMORY");
  }

  public markInMemoryView(tableName: string): void {
    this.originalFiles.delete(tableName);
    this.loadedUrls.set(tableName, "IN_MEMORY_VIEW");
  }

  public async registerFile(tableName: string, file: File): Promise<void> {
    const previousRegistration = this.tableRegistrations.get(tableName);
    const registration = (previousRegistration ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.registerFileNow(tableName, file));

    this.tableRegistrations.set(tableName, registration);

    try {
      await registration;
    } finally {
      if (this.tableRegistrations.get(tableName) === registration) {
        this.tableRegistrations.delete(tableName);
      }
    }
  }

  public async registerArrowIPC(tableName: string, buffer: Uint8Array): Promise<void> {
    const previousRegistration = this.tableRegistrations.get(tableName);
    const registration = (previousRegistration ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.registerArrowIPCNow(tableName, buffer));

    this.tableRegistrations.set(tableName, registration);

    try {
      await registration;
    } finally {
      if (this.tableRegistrations.get(tableName) === registration) {
        this.tableRegistrations.delete(tableName);
      }
    }
  }

  private async registerArrowIPCNow(tableName: string, buffer: Uint8Array): Promise<void> {
    const db = this.getDbOrThrow();
    const connection = await db.connect();
    try {
      await connection.insertArrowTable(tableFromIPC(buffer), { name: tableName });
    } finally {
      await connection.close();
    }

    this.loadedUrls.set(tableName, "IN_MEMORY_ARROW");
  }

  private async registerFileNow(tableName: string, file: File): Promise<void> {
    const db = this.getDbOrThrow();
    const readFunc = getReadFunction(file.name);
    const safeFileName = `${tableName.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}_${crypto.randomUUID()}.${file.name
      .split(".")
      .pop()}`;

    await db.registerFileHandle(safeFileName, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);

    const connection = await db.connect();
    try {
      await connection.query(`DESCRIBE SELECT * FROM ${readFunc}(${quoteSqlString(safeFileName)})`);
      await connection.query(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(tableName)} AS SELECT * FROM ${readFunc}(${quoteSqlString(
          safeFileName
        )})`
      );
    } catch (e) {
      await db.dropFile(safeFileName);
      throw e;
    } finally {
      await connection.close();
    }

    const previousFile = this.registeredFiles.get(tableName);
    if (previousFile) {
      await this.releaseRegisteredPath(previousFile);
    }
    this.registeredFiles.set(tableName, safeFileName);
    this.originalFiles.set(tableName, file);
    this.loadedUrls.set(tableName, "PRELOADED");
  }

  public async loadDataFromUrl(tableName: string, url: string, filename: string): Promise<void> {
    this.getDbOrThrow();

    const cachedUrl = this.loadedUrls.get(tableName);
    if (cachedUrl === url) {
      return;
    }
    if (cachedUrl === "PRELOADED") {
      this.loadedUrls.set(tableName, url);
      return;
    }

    await this.registerRemoteFileUrl(tableName, url, filename);
  }

  public async registerRemoteFileUrl(tableName: string, url: string, filename: string): Promise<void> {
    const db = this.getDbOrThrow();

    const cachedUrl = this.loadedUrls.get(tableName);
    if (cachedUrl === url) {
      return;
    }

    const readFunc = getReadFunction(filename);
    const safeFileName = `${tableName.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}_${crypto.randomUUID()}.${filename
      .split(".")
      .pop()}`;

    await db.registerFileURL(safeFileName, url, duckdb.DuckDBDataProtocol.HTTP, false);

    const connection = await db.connect();
    try {
      await connection.query(`DESCRIBE SELECT * FROM ${readFunc}(${quoteSqlString(safeFileName)})`);
      await connection.query(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(tableName)} AS SELECT * FROM ${readFunc}(${quoteSqlString(
          safeFileName
        )})`
      );
    } catch (e) {
      await db.dropFile(safeFileName);
      throw e;
    } finally {
      await connection.close();
    }

    const previousFile = this.registeredFiles.get(tableName);
    if (previousFile) {
      await this.releaseRegisteredPath(previousFile);
    }
    this.registeredFiles.set(tableName, safeFileName);
    this.originalFiles.delete(tableName);
    this.loadedUrls.set(tableName, url);
  }

  public async releaseTable(tableName: string): Promise<void> {
    const db = this.options.getDb();
    if (!db) {
      return;
    }

    const registration = this.tableRegistrations.get(tableName);
    if (registration) {
      await registration.catch(() => undefined);
    }

    const connection = await db.connect();
    try {
      const registrationType = this.loadedUrls.get(tableName);
      if (registrationType === "IN_MEMORY" || registrationType === "IN_MEMORY_ARROW") {
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
      } else {
        await connection.query(`DROP VIEW IF EXISTS ${quoteIdentifier(tableName)}`);
        await connection.query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
      }
    } finally {
      await connection.close();
    }

    await this.releaseTableRegistration(tableName);
    this.originalFiles.delete(tableName);
    this.options.onReleaseTable?.(tableName);
  }

  public async releaseTableRegistration(tableName: string): Promise<void> {
    const previousFile = this.registeredFiles.get(tableName);
    if (!previousFile) {
      this.loadedUrls.delete(tableName);
      this.originalFiles.delete(tableName);
      return;
    }

    await this.releaseRegisteredPath(previousFile);
  }

  public async releaseRegisteredPath(path: string): Promise<void> {
    const db = this.options.getDb();
    if (!db) {
      return;
    }

    try {
      await db.dropFile(path);
    } catch {
      // Ignore stale registrations.
    } finally {
      for (const [tableName, registeredPath] of this.registeredFiles.entries()) {
        if (registeredPath === path) {
          this.registeredFiles.delete(tableName);
          this.loadedUrls.delete(tableName);
          this.originalFiles.delete(tableName);
        }
      }
    }
  }

  public async getMetadataForLoadedTable(tableName: string): Promise<{ schema: any[]; count: number } | null> {
    const db = this.getDbOrThrow();
    if (!this.loadedUrls.has(tableName)) {
      return null;
    }

    const connection = await db.connect();
    try {
      const schemaResult = await connection.query(`DESCRIBE SELECT * FROM ${quoteIdentifier(tableName)}`);
      const countResult = await connection.query(`SELECT COUNT(*) as count FROM ${quoteIdentifier(tableName)}`);

      const schema = schemaResult.toArray().map((row: any) => row.toJSON());
      const count = countResult.toArray()[0].toJSON().count as number;
      return {
        schema: schema.map((s: any) => ({
          name: s.column_name,
          type: s.column_type,
        })),
        count: Number(count),
      };
    } finally {
      await connection.close();
    }
  }

  private getDbOrThrow(): duckdb.AsyncDuckDB {
    const db = this.options.getDb();
    if (!db) {
      throw new Error("DuckDB not initialized. Call init() first.");
    }
    return db;
  }
}
