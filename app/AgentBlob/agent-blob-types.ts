import type { TLBaseShape } from "tldraw";

export type AgentBlobStatus = "idle" | "thinking" | "working" | "done" | "error";

export type AgentBlobShape = TLBaseShape<
  "agent-blob",
  {
    w: number;
    h: number;
    name: string;
    status: AgentBlobStatus;
    currentJobId: string | null;
    lastMessage: string | null;
    targetShapeIds: string[] | null;
    createdAt: number;
    lastFinishedAt: number | null;
  }
>;
