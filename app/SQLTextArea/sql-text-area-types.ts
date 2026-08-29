import { TLBaseShape } from "tldraw";
import type { ColumnStats } from "../src/duckdb/column-stats-types";

export type SQLTextAreaShape = TLBaseShape<
  "sql-text-area",
  {
    w: number;
    h: number;
    text: string;
    linkedTableId: string | null;
    error: string | null;
    isRunning: boolean;
    query: string | null;
    name: string;
    downstreamShapeIds: string[] | null;
    upstreamShapeIds: string[] | null;
    stale: boolean;
    isDirty: boolean;
    queryStartTime: number | null;
    showTable: boolean;
    runnerName: string | null;
    lastRunStats: {
      executionTime: number;
      rowCount: number;
      runnerName: string;
    } | null;
    outputSchema: { name: string; type: string }[] | null;
    columnStats?: Record<string, ColumnStats> | null;
    isManuallyResized?: boolean;
  }
>;
