import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { AgentBlobShape, AgentBlobStatus } from "./agent-blob-types";
export const CANVAS_BLOB_SIZE = 56;
export const AGENT_BLOB_SHAPE_ID = createShapeId("analytics-agent-blob");

type AgentBlobPlacement = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type UpsertAgentBlobOptions = {
  createIfMissing?: boolean;
  jobId: string | null;
  message?: string | null;
  position: { x: number; y: number };
  preserveTerminalStatus?: boolean;
  status: AgentBlobStatus;
  targetShapeIds?: string[] | null;
};

export function getAgentBlob(editor: Editor) {
  const shape = editor.getShape(AGENT_BLOB_SHAPE_ID);
  if (shape && shape.type !== "agent-blob") {
    throw new Error("Canvas already contains a non-agent shape at the analyst blob id.");
  }
  return shape ? (shape as AgentBlobShape) : null;
}

export function upsertAgentBlob(editor: Editor, options: UpsertAgentBlobOptions) {
  const existingBlob = getAgentBlob(editor);
  if (!existingBlob && options.createIfMissing === false) {
    return false;
  }

  const shouldPreserveTerminalStatus =
    options.preserveTerminalStatus &&
    existingBlob?.props.currentJobId === options.jobId &&
    (existingBlob.props.status === "done" || existingBlob.props.status === "error");
  const status = shouldPreserveTerminalStatus ? existingBlob.props.status : options.status;

  if (existingBlob) {
    editor.updateShape<AgentBlobShape>({
      id: AGENT_BLOB_SHAPE_ID,
      type: "agent-blob",
      x: options.position.x,
      y: options.position.y,
      props: {
        status,
        currentJobId: options.jobId,
        lastMessage: options.message ?? null,
        targetShapeIds: options.targetShapeIds ?? null,
        lastFinishedAt:
          status === "done" || status === "error" ? (existingBlob.props.lastFinishedAt ?? Date.now()) : null,
      },
    });
    editor.bringToFront([AGENT_BLOB_SHAPE_ID]);
    return true;
  }

  editor.createShape<AgentBlobShape>({
    id: AGENT_BLOB_SHAPE_ID,
    type: "agent-blob",
    x: options.position.x,
    y: options.position.y,
    props: {
      w: CANVAS_BLOB_SIZE,
      h: CANVAS_BLOB_SIZE,
      name: "Analyst",
      status,
      currentJobId: options.jobId,
      lastMessage: options.message ?? null,
      targetShapeIds: options.targetShapeIds ?? null,
      createdAt: Date.now(),
      lastFinishedAt: status === "done" || status === "error" ? Date.now() : null,
    },
  });
  editor.bringToFront([AGENT_BLOB_SHAPE_ID]);
  return true;
}

export function moveAgentBlobToPlacement(
  editor: Editor,
  params: AgentBlobPlacement & {
    createIfMissing?: boolean;
    jobId: string | null;
    message?: string | null;
    status?: AgentBlobStatus;
    targetShapeIds?: string[] | null;
  }
) {
  return upsertAgentBlob(editor, {
    createIfMissing: params.createIfMissing ?? false,
    jobId: params.jobId,
    message: params.message,
    position: {
      x: params.x + params.w + 18,
      y: params.y + Math.min(params.h / 2, 96) - CANVAS_BLOB_SIZE / 2,
    },
    preserveTerminalStatus: true,
    status: params.status ?? "working",
    targetShapeIds: params.targetShapeIds,
  });
}

export function moveAgentBlobToShape(
  editor: Editor,
  shapeId: TLShapeId,
  jobId: string | null,
  message?: string | null,
  options: {
    createIfMissing?: boolean;
    status?: AgentBlobStatus;
  } = {}
) {
  const bounds = editor.getShapePageBounds(shapeId);
  if (!bounds) {
    return false;
  }

  return moveAgentBlobToPlacement(editor, {
    x: bounds.x,
    y: bounds.y,
    w: bounds.width,
    h: bounds.height,
    createIfMissing: options.createIfMissing,
    jobId,
    message,
    status: options.status,
    targetShapeIds: [shapeId],
  });
}

export function setAgentBlobStatus(
  editor: Editor,
  status: AgentBlobStatus,
  jobId: string | null,
  message: string | null = null
) {
  const existingBlob = getAgentBlob(editor);
  if (!existingBlob) {
    return false;
  }

  const lastMessage = message ?? existingBlob.props.lastMessage;
  if (
    existingBlob.props.status === status &&
    existingBlob.props.currentJobId === jobId &&
    existingBlob.props.lastMessage === lastMessage
  ) {
    return true;
  }

  editor.updateShape<AgentBlobShape>({
    id: AGENT_BLOB_SHAPE_ID,
    type: "agent-blob",
    props: {
      status,
      currentJobId: jobId,
      lastMessage,
      lastFinishedAt:
        status === "done" || status === "error"
          ? ((existingBlob.props.currentJobId === jobId ? existingBlob.props.lastFinishedAt : null) ?? Date.now())
          : null,
    },
  });
  editor.bringToFront([AGENT_BLOB_SHAPE_ID]);
  return true;
}

export function removeAgentBlob(editor: Editor) {
  if (!getAgentBlob(editor)) {
    return false;
  }
  editor.deleteShapes([AGENT_BLOB_SHAPE_ID]);
  return true;
}

export function startAgentBlob(editor: Editor, jobId: string, targetShapeId?: string) {
  if (
    targetShapeId &&
    moveAgentBlobToShape(editor, targetShapeId as TLShapeId, jobId, "Thinking", {
      createIfMissing: true,
      status: "thinking",
    })
  )
    return;
  const center = editor.getViewportPageBounds().center;
  upsertAgentBlob(editor, {
    jobId,
    position: { x: center.x - CANVAS_BLOB_SIZE / 2, y: center.y - CANVAS_BLOB_SIZE / 2 },
    status: "thinking",
  });
}
