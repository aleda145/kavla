import type { TLBaseShape } from "tldraw";

export type AgentChatEntryRole = "user" | "assistant" | "event" | "error" | "thought" | "query";

export type AgentChatEntry = {
  id: string;
  role: AgentChatEntryRole;
  text: string;
  createdAt: number;
  runId?: string;
  toolCallId?: string;
  messageId?: string;
  shapeIds?: string[];
  contextShapeIds?: string[];
};

export type AgentChatShape = TLBaseShape<
  "agent-chat",
  {
    w: number;
    h: number;
    name: string;
    entries: AgentChatEntry[];
    threadId: string | null;
    isRunning: boolean;
    streamingText: string;
    activity: string | null;
    isOpen: boolean;
    historyClearedAt?: number;
  }
>;
