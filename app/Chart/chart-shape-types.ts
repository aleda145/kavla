import { TLBaseShape } from "tldraw";

export type ChartShape = TLBaseShape<
  "chart-shape",
  {
    sourceShapeId: string | null;
    chartType: string | null;
    x: string | null;
    y: string | null;
    color: string | null;
    yAxisScale: string;
    isStacked: boolean;
    limit: number | null;
    w: number;
    h: number;
    name: string;
  }
>;
