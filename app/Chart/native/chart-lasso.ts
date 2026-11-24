import type { Editor, Group2d, TLDrawShape, TLGeoShape, TLShape, TLShapeId } from "tldraw";
import type { ChartShape } from "../chart-shape-types";
import { limitLassoVertices } from "./lasso-loop";

export type ChartDrawing = TLDrawShape | TLGeoShape;

export function isChartDrawing(shape: TLShape | undefined): shape is ChartDrawing {
  return shape?.type === "draw" || shape?.type === "geo";
}

export function drawingVertices(editor: Editor, drawing: ChartDrawing) {
  if (drawing.type === "draw") return drawing.props.segments.flatMap((segment) => segment.points);
  // GeoShapeUtil uses its first geometry child as the snap outline. Later children are labels or interior marks.
  const outline = editor.getShapeGeometry<Group2d>(drawing).children[0];
  return limitLassoVertices(outline.vertices);
}

export type CaptureMode = "gesture" | "existing";
type LassoTarget = (drawing: ChartDrawing, mode: CaptureMode) => { entry: number; attach: () => void } | null;

// Undo restores the original shape record. Let that undo stand until the drawing or its chart moves.
const captures = new WeakMap<ChartDrawing, { chartId: TLShapeId; placement: string }>();

function placement(editor: Editor, chartId: TLShapeId, drawing: ChartDrawing) {
  const chart = editor.getShape<ChartShape>(chartId);
  if (!chart) return "";
  return [
    chart.props.w,
    chart.props.h,
    editor.getShapePageTransform(chart).toCssString(),
    editor.getShapePageTransform(drawing).toCssString(),
  ].join("|");
}

export function restoredDrawing(editor: Editor, drawing: ChartDrawing) {
  const capture = captures.get(drawing);
  return capture !== undefined && capture.placement === placement(editor, capture.chartId, drawing);
}

export function removeCapturedDrawings(editor: Editor, chartId: TLShapeId, drawings: ChartDrawing[]) {
  for (const drawing of drawings) {
    captures.set(drawing, { chartId, placement: placement(editor, chartId, drawing) });
  }
  editor.deleteShapes(drawings.map((d) => d.id));
}

function observeDrawings(editor: Editor) {
  const targets = new Map<TLShapeId, LassoTarget>();
  const changed = new Set<TLShapeId>();
  const gestures = new Set<TLShapeId>();
  let scanPage = false;

  // Only fresh pen gestures can pick a drawing, offer a slice, or report an unfinished stroke.
  const stopStart = editor.sideEffects.registerBeforeCreateHandler("shape", (shape, source) => {
    if (source === "user" && isChartDrawing(shape)) {
      const drawing = shape.type === "draw" && !shape.props.isComplete && editor.getCurrentToolId() === "draw";
      if (drawing || (shape.type === "geo" && editor.isIn("geo.pointing"))) gestures.add(shape.id);
    }
    return shape;
  });
  const stopCreate = editor.sideEffects.registerAfterCreateHandler("shape", (shape) => {
    if (isChartDrawing(shape)) changed.add(shape.id);
  });
  const stopChange = editor.sideEffects.registerAfterChangeHandler("shape", (before, after) => {
    const moved =
      before.x !== after.x ||
      before.y !== after.y ||
      before.rotation !== after.rotation ||
      before.parentId !== after.parentId ||
      before.isLocked !== after.isLocked;
    if (!moved && before.props === after.props) return;
    if (isChartDrawing(after)) changed.add(after.id);
    if (targets.has(after.id)) scanPage = true;
    if (moved)
      editor.visitDescendants(after.id, (id) => {
        if (targets.has(id)) scanPage = true;
        else if (isChartDrawing(editor.getShape(id))) changed.add(id);
      });
  });
  const stopDelete = editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
    changed.delete(shape.id);
    gestures.delete(shape.id);
  });

  function flush() {
    if (
      (!scanPage && !changed.size) ||
      editor.getIsReadonly() ||
      editor.inputs.isPointing ||
      (editor.isIn("select") && !editor.isIn("select.idle"))
    )
      return;

    const charts = editor
      .getCurrentPageRenderingShapesSorted()
      .filter((s) => targets.has(s.id) && !editor.isShapeOrAncestorLocked(s.id));
    if (scanPage) {
      scanPage = false;
      for (const shape of editor.getCurrentPageShapes()) {
        if (isChartDrawing(shape)) changed.add(shape.id);
      }
    }
    // Finish a pen gesture first when a plot also has older strokes waiting to be checked.
    const candidates = [...changed].sort((a, b) => Number(gestures.has(b)) - Number(gestures.has(a)));
    changed.clear();
    for (const id of candidates) {
      const drawing = editor.getShape(id);
      if (!isChartDrawing(drawing) || (drawing.type === "draw" && !drawing.props.isComplete)) continue;
      const mode = gestures.delete(id) ? "gesture" : "existing";
      if (
        !editor.getCurrentPageShapeIds().has(id) ||
        editor.isShapeOrAncestorLocked(id) ||
        editor.isShapeHidden(id) ||
        restoredDrawing(editor, drawing)
      )
        continue;
      const bounds = editor.getShapeMaskedPageBounds(drawing);
      if (!bounds) continue;
      // The final pen stroke may close a chain from outside the chart.
      const openCharts = new Set<TLShapeId>();
      if (mode === "gesture" && drawing.type === "draw") {
        const nearby = bounds.clone().expandBy(12);
        for (const stroke of editor.getCurrentPageShapes()) {
          if (
            stroke.type !== "draw" ||
            typeof stroke.meta.nativeOpenOutlineChart !== "string" ||
            editor.isShapeOrAncestorLocked(stroke.id)
          )
            continue;
          const strokeBounds = editor.getShapeMaskedPageBounds(stroke);
          if (strokeBounds && nearby.collides(strokeBounds))
            openCharts.add(stroke.meta.nativeOpenOutlineChart as TLShapeId);
        }
      }
      let best: ReturnType<LassoTarget> = null;
      for (const chart of charts) {
        if (!openCharts.has(chart.id) && !editor.getShapeMaskedPageBounds(chart)?.collides(bounds)) continue;
        const candidate = targets.get(chart.id)?.(drawing, mode);
        // Visit back to front so the frontmost chart wins ties.
        if (candidate && (!best || candidate.entry <= best.entry)) best = candidate;
      }
      best?.attach();
    }
  }
  editor.on("tick", flush);
  return {
    targets,
    scan() {
      scanPage = true;
    },
    dispose() {
      editor.off("tick", flush);
      stopStart();
      stopCreate();
      stopChange();
      stopDelete();
    },
  };
}

const observers = new WeakMap<Editor, ReturnType<typeof observeDrawings>>();

export function registerChartLasso(editor: Editor, chartId: TLShapeId, target: LassoTarget) {
  let observer = observers.get(editor);
  if (!observer) {
    observer = observeDrawings(editor);
    observers.set(editor, observer);
  }
  observer.targets.set(chartId, target);
  observer.scan();
  return () => {
    observer.targets.delete(chartId);
    if (observer.targets.size === 0) {
      observer.dispose();
      observers.delete(editor);
    }
  };
}
