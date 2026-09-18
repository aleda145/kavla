import { type RecordProps, T } from "tldraw";
import type { AgentBlobStatus } from "./agent-blob-types";
import type { AgentBlobShape } from "./agent-blob-types";

export const AgentBlobProps: RecordProps<AgentBlobShape> = {
  w: T.number,
  h: T.number,
  name: T.string,
  status: T.string as T.Validator<AgentBlobStatus>,
  currentJobId: T.string.nullable(),
  lastMessage: T.string.nullable(),
  targetShapeIds: T.arrayOf(T.string).nullable(),
  createdAt: T.number,
  lastFinishedAt: T.number.nullable(),
};
