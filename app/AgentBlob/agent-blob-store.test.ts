import assert from "node:assert/strict";
import test from "node:test";
import { Box, createTLSchema, defaultShapeSchemas, type Editor, type TLShapeId, type TLShapePartial } from "tldraw";
import { AgentBlobMigrations } from "./agent-blob-migrations.ts";
import { AgentBlobProps } from "./agent-blob-props.ts";
import { AgentChatProps } from "./agent-chat-props.ts";
import type { AgentBlobShape } from "./agent-blob-types.ts";
import {
  AGENT_BLOB_SHAPE_ID,
  getAgentBlob,
  moveAgentBlobToShape,
  removeAgentBlob,
  setAgentBlobStatus,
  startAgentBlob,
} from "./agent-blob-store.ts";

function canvas() {
  let blob: AgentBlobShape | undefined;
  const bounds = new Map<TLShapeId, Box>();
  const editor = {
    getShape: (id: TLShapeId) => (id === AGENT_BLOB_SHAPE_ID ? blob : undefined),
    getShapePageBounds: (id: TLShapeId) => bounds.get(id),
    getViewportPageBounds: () => new Box(200, 100, 800, 600),
    createShape: (shape: TLShapePartial<AgentBlobShape>) => {
      assert.equal(blob, undefined, "Only one agent blob should exist");
      blob = {
        ...shape,
        typeName: "shape",
        parentId: "page:page",
        index: "a1",
        rotation: 0,
        isLocked: false,
        opacity: 1,
        meta: {},
      } as AgentBlobShape;
    },
    updateShape: (shape: TLShapePartial<AgentBlobShape>) => {
      assert.ok(blob);
      blob = { ...blob, ...shape, props: { ...blob.props, ...shape.props } };
    },
    bringToFront: () => {},
    deleteShapes: () => {
      blob = undefined;
    },
  } as unknown as Editor;
  return { editor, bounds };
}

test("blob follows work in canvas coordinates and keeps its terminal state when the target resizes", () => {
  const { editor, bounds } = canvas();
  const queryId = "shape:query" as TLShapeId;
  const lensId = "shape:lens" as TLShapeId;
  bounds.set(queryId, new Box(100, 200, 400, 300));
  bounds.set(lensId, new Box(700, 200, 600, 500));
  startAgentBlob(editor, "run:1", queryId);
  const first = getAgentBlob(editor)!;
  assert.equal(first.props.status, "thinking");
  assert.ok(first.x > bounds.get(queryId)!.maxX);
  assert.deepEqual(first.props.targetShapeIds, [queryId]);

  moveAgentBlobToShape(editor, lensId, "run:1", "Generating Lens");
  assert.equal(getAgentBlob(editor)!.id, first.id);
  assert.equal(getAgentBlob(editor)!.props.status, "working");
  assert.deepEqual(getAgentBlob(editor)!.props.targetShapeIds, [lensId]);
  setAgentBlobStatus(editor, "done", "run:1", "Done");
  const finishedAt = getAgentBlob(editor)!.props.lastFinishedAt;
  bounds.set(lensId, new Box(900, 300, 800, 600));
  moveAgentBlobToShape(editor, lensId, "run:1");
  assert.ok(getAgentBlob(editor)!.x > bounds.get(lensId)!.maxX);
  assert.equal(getAgentBlob(editor)!.props.status, "done");
  assert.equal(getAgentBlob(editor)!.props.lastFinishedAt, finishedAt);

  startAgentBlob(editor, "run:2", queryId);
  assert.equal(getAgentBlob(editor)!.props.status, "thinking");
  assert.equal(getAgentBlob(editor)!.props.lastFinishedAt, null);
});

test("missing targets fall back to the viewport and deleted blobs stay deleted until the next run", () => {
  const { editor, bounds } = canvas();
  const missingId = "shape:missing" as TLShapeId;
  startAgentBlob(editor, "run:1", missingId);
  const blob = getAgentBlob(editor)!;
  assert.equal(blob.x + blob.props.w / 2, 600);
  assert.equal(blob.y + blob.props.h / 2, 400);
  assert.equal(moveAgentBlobToShape(editor, missingId, "run:1"), false);
  assert.equal(getAgentBlob(editor), blob);

  removeAgentBlob(editor);
  bounds.set(missingId, new Box(10, 20, 300, 400));
  assert.equal(moveAgentBlobToShape(editor, missingId, "run:1"), false);
  assert.equal(setAgentBlobStatus(editor, "done", "run:1"), false);
  assert.equal(getAgentBlob(editor), null);
  startAgentBlob(editor, "run:2", missingId);
  assert.equal(getAgentBlob(editor)!.props.currentJobId, "run:2");
});

test("chat history and blob records round-trip through the canvas schema", () => {
  const shapes = { ...defaultShapeSchemas, "agent-chat": { props: AgentChatProps } };
  const schema = createTLSchema({
    shapes: { ...shapes, "agent-blob": { props: AgentBlobProps, migrations: AgentBlobMigrations } },
  });
  const chat = schema.types.shape.create({
    id: "shape:agent-chat",
    type: "agent-chat",
    parentId: "page:page",
    index: "a1",
    props: {
      w: 1,
      h: 1,
      name: "Agent",
      entries: [{ id: "entry:1", role: "user", text: "Keep my analysis", createdAt: 1 }],
      threadId: "thread:1",
      isRunning: false,
      streamingText: "",
      activity: null,
      isOpen: true,
    },
  });
  schema.types.shape.validator.validate(chat);

  const { editor } = canvas();
  startAgentBlob(editor, "run:1");
  const blob = getAgentBlob(editor)!;
  schema.types.shape.validator.validate(blob);
  const snapshot = JSON.parse(
    JSON.stringify({ schema: schema.serialize(), store: { [chat.id]: chat, [blob.id]: blob } })
  );
  const restored = schema.migrateStoreSnapshot(snapshot);
  assert.equal(restored.type, "success");
  if (restored.type !== "success") return;
  assert.deepEqual(restored.value[chat.id], chat);
  assert.deepEqual(restored.value[blob.id], blob);
});
