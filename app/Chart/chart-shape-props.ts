import { RecordProps, T } from "tldraw";
import { ChartShape } from "./chart-shape-types";

export const ChartShapeProps: RecordProps<ChartShape> = {
  sourceShapeId: T.string.nullable(),
  chartType: T.string.nullable(),
  x: T.string.nullable(),
  y: T.string.nullable(),
  color: T.string.nullable(),
  yAxisScale: T.string,
  isStacked: T.boolean,
  limit: T.number.nullable(),
  w: T.number,
  h: T.number,
  name: T.string,
};
