import { T, type RecordProps, type TLBaseShape } from "tldraw";

export type ExplorationPath = {
  id: string;
  title: string;
  intent: string;
  sourceShapeId: string;
  sql: string;
  rejected: boolean;
};

export type ExplorationShape = TLBaseShape<
  "exploration",
  {
    w: number;
    h: number;
    name: string;
    anchorShapeId: string;
    observation: string;
    question: string;
    paths: ExplorationPath[];
    status: "open" | "chosen" | "parked";
    analystContext: string;
    chosenPathId: string;
    queryShapeId: string;
    sourceRunId: string;
    continuationRunId: string;
    continued: boolean;
  }
>;

export const explorationProps: RecordProps<ExplorationShape> = {
  w: T.number,
  h: T.number,
  name: T.string,
  anchorShapeId: T.string,
  observation: T.string,
  question: T.string,
  paths: T.arrayOf(
    T.object({
      id: T.string,
      title: T.string,
      intent: T.string,
      sourceShapeId: T.string,
      sql: T.string,
      rejected: T.boolean,
    })
  ),
  status: T.literalEnum("open", "chosen", "parked"),
  analystContext: T.string,
  chosenPathId: T.string,
  queryShapeId: T.string,
  sourceRunId: T.string,
  continuationRunId: T.string,
  continued: T.boolean,
};
