import assert from "node:assert/strict";
import test from "node:test";
import type { Editor, TLShape, TLShapeId, TLShapePartial } from "tldraw";
import { getAgentLayout, getAgentPlacement, reflowAgentQuery, registerAgentQueryReflow, trackAgentQueryLayout } from "./agentLayout.ts";
import { getAutoExpandedSQLShapeSize } from "../SQLTextArea/sqlShapeSize.ts";

type TestShape = TLShape & { props: { w: number; h: number; linkedTableId?: string | null; isManuallyResized?: boolean } };
function shape(name: string, type: string, x: number, y: number, w = 400, h = 300): TestShape {
  return { id: `shape:${name}`, type, x, y, rotation: 0, parentId: "page:page", props: { w, h }, meta: {}, isLocked: false } as TestShape;
}

function canvas(...initial: TestShape[]) {
  const shapes = new Map(initial.map((item) => [item.id, item]));
  let listener: ((previous: TLShape, next: TLShape) => void) | undefined;
  const bounds = (id: TLShapeId) => {
    const item = shapes.get(id);
    if (!item) return undefined;
    return { minX: item.x, minY: item.y, maxX: item.x + item.props.w, maxY: item.y + item.props.h, x: item.x, y: item.y, w: item.props.w, h: item.props.h, width: item.props.w, height: item.props.h };
  };
  const editor = {
    getShape: (id: TLShapeId) => shapes.get(id),
    getCurrentPageShapes: () => [...shapes.values()],
    getShapePageBounds: bounds,
    getViewportPageBounds: () => ({ center: { x: 0, y: 0 } }),
    getPointInParentSpace: (_shape: TLShape, point: { x: number; y: number }) => point,
    hasAncestor: () => false,
    run: (callback: () => void) => callback(),
    updateShape: (update: TLShapePartial) => {
      const previous = shapes.get(update.id)!;
      const next = { ...previous, ...update, props: { ...previous.props, ...update.props } } as TestShape;
      shapes.set(update.id, next);
      listener?.(previous, next);
    },
    sideEffects: {
      registerAfterChangeHandler: (_type: string, callback: typeof listener) => {
        listener = callback;
        return () => { listener = undefined; };
      },
    },
  } as unknown as Editor;
  return { editor, shapes, bounds };
}

function assertClear(state: ReturnType<typeof canvas>, id: TLShapeId) {
  const a = state.bounds(id)!;
  for (const other of state.shapes.values()) {
    if (other.id === id || ["arrow", "agent-blob", "agent-chat"].includes(other.type)) continue;
    const b = state.bounds(other.id)!;
    assert.ok(a.maxX <= b.minX - 28 || a.minX >= b.maxX + 28 || a.maxY <= b.minY - 28 || a.minY >= b.maxY + 28, `${id} overlaps ${other.id}`);
  }
}

test("generated SQL grows beyond its placeholder and is placed clear of existing analysis", () => {
  const source = shape("source", "data-source", 0, 0);
  const query = shape("query", "sql-text-area", 470, 0);
  const sibling = shape("sibling", "sql-text-area", 470, 360);
  const state = canvas(source, query, sibling);
  trackAgentQueryLayout(state.editor, query.id, getAgentLayout({}, source.id, "right"));
  const originalSibling = state.shapes.get(sibling.id);
  const longSQL = Array.from({ length: 30 }, (_, i) => `  column_${i}_with_a_long_name,`).join("\n");
  state.editor.updateShape({ id: query.id, type: query.type, props: getAutoExpandedSQLShapeSize(longSQL) });
  reflowAgentQuery(state.editor, query.id);
  assertClear(state, query.id);
  assert.equal(state.shapes.get(sibling.id), originalSibling, "Existing analysis stays in place");
});

test("late editor growth reflows the query and checks its full-size result against other shapes", () => {
  const source = shape("source", "data-source", 0, 0);
  const query = shape("query", "sql-text-area", 470, 0);
  const result = shape("result", "sql-result-table", 470, 360, 550, 420);
  query.props.linkedTableId = result.id;
  const sibling = shape("sibling", "sql-text-area", 940, 360);
  const state = canvas(source, query, result, sibling);
  trackAgentQueryLayout(state.editor, query.id, getAgentLayout({}, source.id, "right"));
  // Reproduce a result that grows after its initial placement.
  state.editor.updateShape({ id: result.id, type: result.type, x: sibling.x - 200, y: sibling.y });
  const stop = registerAgentQueryReflow(state.editor);
  state.editor.updateShape({ id: query.id, type: query.type, props: { w: 600, h: 600 } });
  assertClear(state, query.id);
  assertClear(state, result.id);
  stop();
});

test("clear positions and manually sized or locked queries are preserved", () => {
  for (const mode of ["clear", "manual", "locked", "untracked"]) {
    const source = shape("source", "data-source", 0, 0);
    const query = shape("query", "sql-text-area", 470, 0);
    const state = canvas(source, query);
    if (mode !== "untracked") trackAgentQueryLayout(state.editor, query.id, getAgentLayout({}, source.id, "right"));
    if (mode === "manual") state.editor.updateShape({ id: query.id, type: query.type, props: { isManuallyResized: true } });
    if (mode === "locked") state.editor.updateShape({ id: query.id, type: query.type, isLocked: true });
    if (mode !== "clear") state.shapes.set("shape:obstacle" as TLShapeId, shape("obstacle", "note", 940, 0));
    const stop = registerAgentQueryReflow(state.editor);
    state.editor.updateShape({ id: query.id, type: query.type, props: { w: 600, h: 600 } });
    assert.equal(state.shapes.get(query.id)!.x, 470, mode);
    assert.equal(state.shapes.get(query.id)!.y, 0, mode);
    stop();
  }
});

test("saved layout metadata resumes size tracking without changing shape props", () => {
  const source = shape("source", "data-source", 0, 0);
  const query = shape("query", "sql-text-area", 470, 0);
  const state = canvas(source, query, shape("sibling", "sql-text-area", 470, 360));
  const originalProps = state.shapes.get(query.id)!.props;
  trackAgentQueryLayout(state.editor, query.id, getAgentLayout({}, source.id, "right"));
  assert.deepEqual(state.shapes.get(query.id)!.props, originalProps);
  const restored = canvas(...JSON.parse(JSON.stringify([...state.shapes.values()])));
  registerAgentQueryReflow(restored.editor);
  restored.editor.updateShape({ id: query.id, type: query.type, props: { w: 600, h: 600 } });
  assertClear(restored, query.id);
});

test("a crowded canvas falls back to free space beyond the occupied area", () => {
  const source = shape("source", "data-source", 0, 0);
  const obstacle = shape("obstacle", "note", -10000, -10000, 20000, 20000);
  const state = canvas(source, obstacle);
  const placement = getAgentPlacement(state.editor, getAgentLayout({}, source.id, "right"), source.id, { w: 600, h: 600 });
  assert.ok(placement.x > obstacle.x + obstacle.props.w);
});
