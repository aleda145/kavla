import { TLBaseShape, TLDefaultColorStyle } from "tldraw";
import type { RemoteSourceInfo } from "../SQLTextArea/remote-column-stats";
import type { ColumnStats } from "../src/duckdb/column-stats-types";

export type ColumnMetadata = {
  name: string;
  type: string;
};

export type SchemaTableProps = {
  metadata: ColumnMetadata[] | null;
  selectedColumns?: Set<string>;
  onColumnClick?: (columnName: string, shiftKey: boolean) => void;
  tableName: string;
  columnStats?: Record<string, ColumnStats> | null;
  remoteSource?: RemoteSourceInfo | null;
};

export type DataSourceShape = TLBaseShape<
  "data-source",
  {
    w: number;
    h: number;
    color: TLDefaultColorStyle;
    text: string;
    error: string | null;
    isRunning: boolean;
    name: string;
    filename: string | null;
    sourceName: string | null;
    sourceType: string | null;
    remoteTableRef: string | null;
    rowCount: number | null;
    downstreamShapeIds: string[] | null;
    upstreamShapeIds: string[] | null;
    metadata: ColumnMetadata[] | null;
    fileSize: number | null;
    columnStats?: Record<string, ColumnStats> | null;
  }
>;
