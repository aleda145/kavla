import { type RecordProps, T } from "tldraw";
import type { CodexAgentEntryRole, CodexAgentShape } from "./codex-agent-types";

export const CodexAgentProps: RecordProps<CodexAgentShape> = {
  w: T.number,
  h: T.number,
  name: T.string,
  entries: T.arrayOf(T.object({
    id: T.string,
    role: T.string as T.Validator<CodexAgentEntryRole>,
    text: T.string,
    createdAt: T.number,
    runId: T.string.optional(),
    toolCallId: T.string.optional(),
    shapeIds: T.arrayOf(T.string).optional(),
    contextShapeIds: T.arrayOf(T.string).optional(),
  })),
  codexThreadId: T.string.nullable(),
  isRunning: T.boolean,
  streamingText: T.string,
  activity: T.string.nullable(),
  isOpen: T.boolean,
  historyClearedAt: T.number.optional(),
};
