import { RecordProps, T } from "tldraw";
import { SummaryShape } from "./summary-shape-types";

export const SummaryShapeProps: RecordProps<SummaryShape> = {
  w: T.number,
  h: T.number,
  name: T.string,
  question: T.string,
  answer: T.string,
  sections: T.arrayOf(
    T.object({
      title: T.string,
      body: T.string,
    })
  ),
  artifacts: T.arrayOf(
    T.object({
      shapeId: T.string,
      artifactId: T.string.nullable().optional(),
      kind: T.string,
      title: T.string,
      note: T.string,
    })
  ),
  sourceJobId: T.string.nullable(),
  agentShapeId: T.string.nullable(),
};
