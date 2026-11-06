import { sessionFetch, withBackendActivity } from "./backendCompute";
import { transpileRemoteSQL } from "./localServer/runtimeStore";
import type { RunRemoteQueryPayload } from "./localServer/types";

export type QueryEstimateRequest = Pick<RunRemoteQueryPayload, "sql" | "sourceName" | "sourceType" | "sourceNative">;

export interface QueryEstimate {
  engine: string;
  // The backend preserves the full int64 value across JSON.
  bytesProcessed: string;
}

export function supportsQueryEstimate(request: QueryEstimateRequest): boolean {
  return Boolean(request.sourceNative && request.sourceName && request.sourceType?.trim() === "bigquery");
}

// Execution and estimation must transpile exactly the same SQL.
export function prepareRemoteQuery(request: QueryEstimateRequest): { sql: string; executionEngine?: string } {
  const executionEngine = request.sourceNative ? request.sourceType?.trim() || undefined : undefined;
  if (executionEngine && !request.sourceName) throw new Error("sourceName is required for source-native preview");
  return {
    sql: executionEngine ? transpileRemoteSQL(request.sql, request.sourceName!, executionEngine) : request.sql,
    executionEngine,
  };
}

export async function estimateQuery(request: QueryEstimateRequest, signal?: AbortSignal): Promise<QueryEstimate> {
  if (!supportsQueryEstimate(request)) throw new Error("Dry runs are not available for this query's execution engine.");
  const prepared = prepareRemoteQuery(request);
  return withBackendActivity(async () => {
    const response = await sessionFetch("/api/session/query-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...prepared, sourceName: request.sourceName }),
      signal,
    });
    if (!response.ok) {
      const message = response.headers.get("Content-Type")?.includes("application/json")
        ? ((await response.json()) as { error?: string }).error
        : await response.text();
      throw new Error(message || "Could not estimate this query.");
    }
    const estimate = (await response.json()) as QueryEstimate;
    if (typeof estimate.bytesProcessed !== "string" || !/^\d+$/.test(estimate.bytesProcessed)) {
      throw new Error("The server did not return a processed-byte estimate.");
    }
    return estimate;
  });
}

export function formatProcessedBytes(value: string): string {
  const bytes = Number(value);
  if (bytes === 0) return "0 MB";
  if (bytes < 1e6) return "<1 MB";
  const divisor = bytes >= 1e12 ? 1e12 : bytes >= 1e9 ? 1e9 : 1e6;
  const unit = divisor === 1e12 ? "TB" : divisor === 1e9 ? "GB" : "MB";
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${unit}`;
}

export function formatEstimatedQueryCost(value: string): string {
  const dollars = (Number(value) / 2 ** 40) * 6.25;
  if (dollars > 0 && dollars < 0.000001) return "<$0.000001";
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
