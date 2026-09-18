import { TLBaseShape } from "tldraw";

export type LensShape = TLBaseShape<
  "lens-shape",
  {
    sourceShapeId: string | null;
    prompt: string;
    dataSql: string | null;
    code: string;
    title: string;
    description: string | null;
    jobId: string | null;
    generatedAt: number | null;
    error: string | null;
    retryCount: number;
    generationStatus: string;
    w: number;
    h: number;
    name: string;
  }
>;
