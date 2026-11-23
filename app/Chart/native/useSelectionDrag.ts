import { useEffect, useState, type PointerEvent, type SVGProps } from "react";
import type { Editor } from "tldraw";
import type { ChartData } from "./chart-data";
import {
  resizeSelection,
  selectionRegion,
  translateSelection,
  type chartGeometry,
  type ResizeHandle,
} from "./geometry";
import { containsPoint, type ChartSelection, type Point } from "./selection";

type Geometry = ReturnType<typeof chartGeometry>;
type PolygonEvent = PointerEvent<SVGPolygonElement>;

function plotPoint(event: PolygonEvent, geometry: Geometry): Point {
  const transform = event.currentTarget.getScreenCTM()!;
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
  return geometry.toAnalytical(local);
}

export function useSelectionDrag(
  editor: Editor,
  selections: ChartSelection[],
  geometry: Geometry | null,
  data: ChartData | null,
  color: string | null,
  focusedId: string | null,
  onFocus: (drawingId: string | null) => void,
  onDelete: (drawingId: string) => void,
  onCommit: (next: ChartSelection) => void
) {
  const [gesture, setGesture] = useState<{
    target: SVGPolygonElement;
    pointerId: number;
    start: Point;
    screen: Point;
    clickId: string;
    handle?: ResizeHandle;
    selection: ChartSelection;
    geometry: Geometry;
  } | null>(null);
  const [draft, setDraft] = useState<{ selection: ChartSelection; handle?: ResizeHandle } | null>(null);
  const active = gesture && selections.includes(gesture.selection) && gesture.geometry === geometry ? gesture : null;

  function cancel() {
    setGesture(null);
    setDraft(null);
  }

  useEffect(() => {
    if (!gesture) return;
    if (!active) {
      cancel();
      return;
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      if (gesture.target.hasPointerCapture(gesture.pointerId)) gesture.target.releasePointerCapture(gesture.pointerId);
    };
  }, [gesture, active]);

  function editedSelection(event: PolygonEvent) {
    if (!active || !geometry || !data) return null;
    if (Math.hypot(event.clientX - active.screen.x, event.clientY - active.screen.y) < 3) return null;
    const selection = active.selection;
    const end = plotPoint(event, geometry);
    const resize = active.handle
      ? resizeSelection(
          selection.polygon,
          active.handle,
          { x: end.x - active.start.x, y: end.y - active.start.y },
          geometry.plot
        )
      : null;
    const polygon = active.handle
      ? resize?.polygon
      : translateSelection(selection.polygon, active.start, end, geometry.plot);
    if (!polygon) return null;
    return { selection: { ...selection, ...selectionRegion(data, geometry, polygon, color) }, handle: resize?.handle };
  }

  function handlersFor(selection: ChartSelection, index: number, handle?: ResizeHandle): SVGProps<SVGPolygonElement> {
    const cursorHandle = active?.handle === handle ? (draft?.handle ?? handle) : handle;
    return {
      tabIndex: 0,
      role: "button",
      "aria-label": handle ? `Resize drawing ${index + 1} (${handle.toUpperCase()})` : `Select drawing ${index + 1}`,
      style: {
        pointerEvents: "all",
        touchAction: "none",
        cursor: cursorHandle ? `${cursorHandle}-resize` : active ? "grabbing" : "grab",
      },
      onFocus: () => onFocus(selection.drawingId),
      onKeyDown(event) {
        if (handle && geometry && data && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          if (active) return;
          const step = event.shiftKey ? 10 : 1;
          const x = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
          const y = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
          const resize = resizeSelection(
            selection.polygon,
            handle,
            {
              x: x / geometry.plot.width,
              y: y / geometry.plot.height,
            },
            geometry.plot
          );
          if (resize) {
            onCommit({ ...selection, ...selectionRegion(data, geometry, resize.polygon, color) });
            if (resize.handle !== handle) {
              event.currentTarget
                .closest("[data-chart-drawing]")
                ?.querySelector<SVGPolygonElement>(`[data-resize-handle="${resize.handle}"]`)
                ?.focus();
            }
          }
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          event.stopPropagation();
          onDelete(selection.drawingId);
        } else if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onFocus(event.key === "Escape" ? null : selection.drawingId);
        }
      },
      onPointerDown(event) {
        if (!geometry || !event.isPrimary || event.button !== 0 || editor.inputs.isPanning || active) return;
        event.stopPropagation();
        event.preventDefault();
        const start = plotPoint(event, geometry);
        // Repeated clicks cycle through overlapping drawings. Drag the one already in focus.
        let grabbed = selection;
        let clicked = selection;
        if (!handle) {
          const hits = selections.filter((r) => r === selection || containsPoint(start, r.polygon)).reverse();
          const index = hits.findIndex((r) => r.drawingId === focusedId);
          grabbed = hits[index] ?? selection;
          clicked = index < 0 ? selection : hits[(index + 1) % hits.length];
        }
        onFocus(grabbed.drawingId);
        event.currentTarget.setPointerCapture(event.pointerId);
        setGesture({
          target: event.currentTarget,
          pointerId: event.pointerId,
          start,
          clickId: clicked.drawingId,
          handle,
          screen: { x: event.clientX, y: event.clientY },
          selection: grabbed,
          geometry,
        });
      },
      onPointerMove(event) {
        if (event.pointerId !== active?.pointerId) return;
        event.stopPropagation();
        setDraft(editedSelection(event));
      },
      onPointerUp(event) {
        if (event.pointerId !== active?.pointerId) return;
        event.stopPropagation();
        const next = editedSelection(event);
        cancel();
        if (next) onCommit(next.selection);
        else onFocus(active.clickId);
      },
      onLostPointerCapture(event) {
        if (event.pointerId === active?.pointerId) cancel();
      },
      onPointerCancel(event) {
        if (event.pointerId === active?.pointerId) {
          event.stopPropagation();
          cancel();
        }
      },
    };
  }
  return { draft: active ? draft?.selection : null, resizing: Boolean(active?.handle), handlersFor };
}
