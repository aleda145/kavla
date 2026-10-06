import type { TLBaseShape } from "tldraw";

export type KnobTemporalType = "date" | "timestamp" | "timestamptz";

export type KnobShape = TLBaseShape<
  "knob",
  {
    w: number;
    h: number;
    name: string;
    value: number;
    min: number;
    max: number;
    step: number;
    kind?: "numeric" | "category" | "timestamp";
    temporalType?: KnobTemporalType;
    categoryType?: "text" | "boolean";
    categoryValue?: string;
    options?: string[];
    optionsTruncated?: boolean;
    inferFromColumn?: boolean;
    inferenceQueryId?: string;
    inferenceStatus?: "loading" | "ready" | "error";
    inferenceError?: string | null;
    downstreamShapeIds: string[] | null;
    upstreamShapeIds: string[] | null;
  }
>;
