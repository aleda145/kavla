import { TLBaseShape } from "tldraw";

export type SummaryArtifactKind = string;

export type SummaryArtifact = {
  shapeId: string;
  artifactId?: string | null;
  kind: SummaryArtifactKind;
  title: string;
  note: string;
};

export type SummarySection = {
  title: string;
  body: string;
};

export type SummaryShape = TLBaseShape<
  "summary-shape",
  {
    w: number;
    h: number;
    name: string;
    question: string;
    answer: string;
    sections: SummarySection[];
    artifacts: SummaryArtifact[];
    sourceJobId: string | null;
    agentShapeId: string | null;
  }
>;
