import { RecordProps, T } from "tldraw";
import { SQLResultTableShape } from "./sql-result-table-types";

export const SQLResultTableProps: RecordProps<SQLResultTableShape> = {
  sourceShapeId: T.string.nullable(),
  w: T.number,
  h: T.number,
  scrollTop: T.number.optional(),
  scrollLeft: T.number.optional(),
  columnSizing: T.dict(T.string, T.number),
};
