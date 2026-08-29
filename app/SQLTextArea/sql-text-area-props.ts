import { RecordProps, T } from "tldraw";
import { SQLTextAreaShape } from "./sql-text-area-types";

export const SQLTextAreaProps: RecordProps<SQLTextAreaShape> = {
  w: T.number,
  h: T.number,
  text: T.string,
  linkedTableId: T.string.nullable(),
  error: T.string.nullable(),
  isRunning: T.boolean,
  query: T.string.nullable(),
  name: T.string,
  downstreamShapeIds: T.arrayOf(T.string).nullable(),
  upstreamShapeIds: T.arrayOf(T.string).nullable(),
  stale: T.boolean,
  isDirty: T.boolean,
  queryStartTime: T.number.nullable(),
  showTable: T.boolean,
  runnerName: T.string.nullable(),
  lastRunStats: T.object({
    executionTime: T.number,
    rowCount: T.number,
    runnerName: T.string,
  }).nullable(),
  outputSchema: T.arrayOf(
    T.object({
      name: T.string,
      type: T.string,
    })
  ).nullable(),
  columnStats: (T.any as T.Validator<Record<string, any> | null>).nullable().optional(),
  isManuallyResized: T.boolean.optional(),
};
