import type { TLBaseShape } from "tldraw";

export type CodexAgentEntryRole = "user" | "assistant" | "event" | "error";

export type CodexAgentEntry = {
  id: string;
  role: CodexAgentEntryRole;
  text: string;
  createdAt: number;
  shapeIds?: string[];
  contextShapeIds?: string[];
};

export type CodexAgentShape = TLBaseShape<
  "codex-agent",
  {
    w: number;
    h: number;
    name: string;
    entries: CodexAgentEntry[];
    codexThreadId: string | null;
    isRunning: boolean;
    streamingText: string;
    activity: string | null;
    isOpen: boolean;
  }
>;
