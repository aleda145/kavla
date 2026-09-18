import { RecordProps, T } from "tldraw";
import { LensShape } from "./lens-shape-types";

export const LensShapeProps: RecordProps<LensShape> = {
  sourceShapeId: T.string.nullable(),
  prompt: T.string,
  dataSql: T.string.nullable(),
  code: T.string,
  title: T.string,
  description: T.string.nullable(),
  jobId: T.string.nullable(),
  generatedAt: T.number.nullable(),
  error: T.string.nullable(),
  retryCount: T.number,
  generationStatus: T.string,
  w: T.number,
  h: T.number,
  name: T.string,
};
