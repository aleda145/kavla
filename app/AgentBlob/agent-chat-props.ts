import { type RecordProps, T } from "tldraw";
import type { AgentChatEntryRole, AgentChatShape } from "./agent-chat-types";

export const AgentChatProps: RecordProps<AgentChatShape> = {
  w: T.number,
  h: T.number,
  name: T.string,
  entries: T.arrayOf(T.object({
    id: T.string,
    role: T.string as T.Validator<AgentChatEntryRole>,
    text: T.string,
    createdAt: T.number,
    runId: T.string.optional(),
    toolCallId: T.string.optional(),
    messageId: T.string.optional(),
    shapeIds: T.arrayOf(T.string).optional(),
    contextShapeIds: T.arrayOf(T.string).optional(),
  })),
  threadId: T.string.nullable(),
  isRunning: T.boolean,
  streamingText: T.string,
  activity: T.string.nullable(),
  isOpen: T.boolean,
  historyClearedAt: T.number.optional(),
};
