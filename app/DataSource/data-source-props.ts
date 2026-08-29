import { T } from "tldraw";

export const DataSourceProps = {
  w: T.number,
  h: T.number,
  color: T.string,
  text: T.string,
  error: T.string.nullable(),
  fileSize: T.number.nullable(),
  isRunning: T.boolean,
  name: T.string,
  filename: T.string.nullable(),
  sourceName: T.string.nullable(),
  sourceType: T.string.nullable(),
  remoteTableRef: T.string.nullable(),
  rowCount: T.number.nullable(),
  downstreamShapeIds: T.arrayOf(T.string).nullable(),
  upstreamShapeIds: T.arrayOf(T.string).nullable(),
  metadata: T.arrayOf(T.object({ name: T.string, type: T.string })).nullable(),
  columnStats: (T.any as T.Validator<Record<string, any> | null>).nullable().optional(),
};
