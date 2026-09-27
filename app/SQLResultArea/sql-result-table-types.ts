import { TLBaseShape } from "tldraw";

export type SQLResultTableShape = TLBaseShape<
  "sql-result-table",
  {
    sourceShapeId: string | null;
    w: number;
    h: number;
    isManuallyResized?: boolean;
    scrollTop?: number;
    scrollLeft?: number;
    columnSizing: Record<string, number>;
  }
>;
