import { DuckDBService } from "@/duckdb-service";
import { getSessionBlob, getSessionBlobUrl } from "./localSession";

export async function ensureBundledSourceTable(options: {
  shapeId: string;
  tableName: string;
  filename: string;
}): Promise<boolean> {
  const duckDB = DuckDBService.getInstance();
  if (duckDB.isTableLoaded(options.tableName)) return true;

  const descriptor = getSessionBlob("source", options.shapeId);
  if (!descriptor) return false;

  await duckDB.init();
  await duckDB.registerRemoteFileUrl(options.tableName, getSessionBlobUrl(descriptor.id), descriptor.fileName);
  return true;
}
