import type { Editor, TLDrawShape, TLShapeId } from "tldraw";

type LassoTarget = (drawing: TLDrawShape) => { entry: number; attach: () => void } | null;

function observeDrawings(editor: Editor) {
  const targets = new Map<TLShapeId, LassoTarget>();
  const pending = new Set<TLShapeId>();
  // Completed strokes restored by undo, paste, or document loading are not new gestures.
  const stopCreate = editor.sideEffects.registerAfterCreateHandler("shape", (shape, source) => {
    if (
      source === "user" &&
      editor.isShapeOfType<TLDrawShape>(shape, "draw") &&
      !shape.props.isComplete &&
      editor.getCurrentToolId() === "draw"
    ) {
      pending.add(shape.id);
    }
  });
  const stopChange = editor.sideEffects.registerAfterChangeHandler("shape", (before, after, source) => {
    if (
      source !== "user" ||
      !editor.isShapeOfType<TLDrawShape>(after, "draw") ||
      !editor.isShapeOfType<TLDrawShape>(before, "draw") ||
      before.props.isComplete ||
      !after.props.isComplete ||
      !pending.delete(after.id)
    )
      return;
    queueMicrotask(() => {
      const drawing = editor.getShape<TLDrawShape>(after.id);
      if (drawing?.type !== "draw" || !drawing.props.isComplete) return;
      const bounds = editor.getShapePageBounds(drawing);
      if (!bounds) return;
      // The final stroke can sit outside the frame while closing an outline that surrounds the plot.
      const nearby = bounds.clone().expandBy(12);
      const openCharts = new Set<TLShapeId>();
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
      let best: ReturnType<LassoTarget> = null;
      // Visit back to front so the top chart wins when the pen enters both at once.
      for (const shape of editor.getCurrentPageRenderingShapesSorted()) {
        const target = targets.get(shape.id);
        if (!target || editor.isShapeOrAncestorLocked(shape.id)) continue;
        if (!openCharts.has(shape.id) && !editor.getShapeMaskedPageBounds(shape)?.collides(bounds)) continue;
        const candidate = target(drawing);
        if (candidate && (!best || candidate.entry <= best.entry)) best = candidate;
      }
      best?.attach();
    });
  });
  const stopDelete = editor.sideEffects.registerAfterDeleteHandler("shape", (record) => {
    pending.delete(record.id);
  });
  return {
    targets,
    dispose() {
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
  return () => {
    observer.targets.delete(chartId);
    if (observer.targets.size === 0) {
      observer.dispose();
      observers.delete(editor);
    }
  };
}
