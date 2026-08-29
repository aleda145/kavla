import type * as duckdb from "@duckdb/duckdb-wasm";

interface PrintDuckDBHeapOptions {
  db: duckdb.AsyncDuckDB;
  getLoadedUrlsSnapshot: () => [string, string][];
  getMetadataCacheSnapshot: () => [string, { schema: any[]; count: number }][];
}

export async function printDuckDBHeap({
  db,
  getLoadedUrlsSnapshot,
  getMetadataCacheSnapshot,
}: PrintDuckDBHeapOptions): Promise<void> {
  const connection = await db.connect();
  console.group("🦆 DuckDB State");

  try {
    console.log("--- Tables & Views ---");
    try {
      const tables = await connection.query("SHOW ALL TABLES;");
      console.table(tables.toArray().map((r: any) => r.toJSON()));
    } catch (e) {
      console.error("Failed to list tables", e);
    }

    console.log("--- Loaded URLs Cache ---");
    console.table(getLoadedUrlsSnapshot());

    console.log("--- Metadata Cache ---");
    console.table(getMetadataCacheSnapshot());

    console.log("--- Storage Info ---");
    try {
      const size = await connection.query("PRAGMA database_size;");
      console.table(size.toArray().map((r: any) => r.toJSON()));
    } catch {
      console.log("Could not fetch database size via PRAGMA.");
    }

    console.log("--- Virtual Filesystem (WASM Memory) ---");
    try {
      const files = await connection.query("SELECT file FROM glob('**') WHERE file LIKE '%.parquet'");
      const fileList: { file: string; size?: string }[] = [];
      let totalSize = 0;

      for (const row of files.toArray()) {
        const file = row.toJSON().file;
        try {
          const meta = await connection.query(
            `SELECT sum(total_compressed_size) as size FROM parquet_metadata('${file}')`
          );
          const size = Number(meta.toArray()[0].toJSON().size);
          totalSize += size;
          fileList.push({ file, size: (size / 1024 / 1024).toFixed(2) + " MB" });
        } catch {
          fileList.push({ file, size: "Unknown (not parquet?)" });
        }
      }

      console.table(fileList);
      console.log(`Total Parquet Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      console.error("Failed to list/analyze virtual files", e);
    }

    console.log("--- Browser Memory API (Heap) ---");
    if ((performance as any).memory) {
      const mem = (performance as any).memory;
      console.table({
        jsHeapSizeLimit: (mem.jsHeapSizeLimit / 1024 / 1024).toFixed(2) + " MB",
        totalJSHeapSize: (mem.totalJSHeapSize / 1024 / 1024).toFixed(2) + " MB",
        usedJSHeapSize: (mem.usedJSHeapSize / 1024 / 1024).toFixed(2) + " MB",
      });
    } else {
      console.log("performance.memory not available in this browser.");
    }
  } finally {
    console.groupEnd();
    await connection.close();
  }
}
