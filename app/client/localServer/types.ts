import type { TLShapeId } from "tldraw";

export type UnsubscribeFn = () => void;

export class MissingQueryResultError extends Error {
  constructor(message = "This query result is not loaded. Run the query to load it.") {
    super(message);
    this.name = "MissingQueryResultError";
  }
}

export interface MountedFileSourcePayload {
  sourceName: string;
  blobId: string;
  fileName: string;
}

export interface RunRemoteQueryPayload {
  sql: string;
  sourceName?: string;
  sourceType?: string | null;
  shapeId: string;
  queryName?: string;
  sourceNative?: boolean;
  mountedFileSources?: MountedFileSourcePayload[];
  transient?: boolean;
  restore?: boolean;
}

export interface QueryResultPagePayload {
  shapeId: string;
  offset: number;
  limit: number;
  signal?: AbortSignal;
}

export interface QueryResultPage {
  rows: Record<string, unknown>[];
}

export interface AgentPromptPayload {
  runId: string;
  prompt: string;
  threadId: string | null;
  context: unknown;
  fallbackHistory: string;
  mainModel?: string;
}

export interface AgentToolResultPayload {
  runId: string;
  callId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface LocalServerContextType {
  updateSourceName: (payload: { prevName: string; nextName: string }) => void;
  deleteShapes: (ids: TLShapeId[]) => void;
  getSourceTables: (payload: { sourceName: string }) => Promise<{ tables: string[] }>;
  getSourceSchema: (payload: { tableRef: string }) => Promise<{ columns: { name: string; type: string }[] }>;
  getSourceStats: (payload: { tableRef: string }) => Promise<{ rowCount: number }>;
  prepareSourceDownload: (payload: {
    tableRef: string;
    format: "csv" | "parquet";
    fileName: string;
    rowCount: number | null;
  }) => Promise<{ downloadUrl: string; fileName: string }>;
  prepareQueryResultDownload: (payload: {
    shapeId: string;
    format: "csv" | "parquet";
    fileName: string;
  }) => Promise<{ downloadUrl: string; fileName: string }>;
  runRemoteQuery: (payload: RunRemoteQueryPayload) => Promise<{
    rowCount: number;
    schema: { name: string; type: string }[];
    sampleRows: Record<string, unknown>[];
  }>;
  getQueryResultPage: (payload: QueryResultPagePayload) => Promise<QueryResultPage>;
  cancelRemoteQuery: (shapeId: string, queryName?: string) => void;
  sendAgentPrompt: (payload: AgentPromptPayload) => void;
  sendAgentToolResult: (payload: AgentToolResultPayload) => void;
  cancelAgent: () => void;
  retryAgent: () => void;
}
