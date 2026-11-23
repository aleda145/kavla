import { useEffect, useState, type PointerEvent, type SVGProps } from "react";
import type { Editor } from "tldraw";
import type { ChartData } from "./chart-data";
import { selectionRegion, translateSelection, type chartGeometry } from "./geometry";
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
    selection: ChartSelection;
    geometry: Geometry;
  } | null>(null);
  const [draft, setDraft] = useState<ChartSelection | null>(null);
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

  function movedSelection(event: PolygonEvent): ChartSelection | null {
    if (!active || !geometry || !data) return null;
    if (Math.hypot(event.clientX - active.screen.x, event.clientY - active.screen.y) < 3) return null;
    const selection = active.selection;
    const moved = translateSelection(selection.polygon, active.start, plotPoint(event, geometry), geometry.plot);
    return moved && { ...selection, ...selectionRegion(data, geometry, moved, color) };
  }

  function handlersFor(selection: ChartSelection, index: number): SVGProps<SVGPolygonElement> {
    return {
      tabIndex: 0,
      role: "button",
      "aria-label": `Select drawing ${index + 1}`,
      style: { pointerEvents: "all", touchAction: "none", cursor: active ? "grabbing" : "grab" },
      onFocus: () => onFocus(selection.drawingId),
      onKeyDown(event) {
        if (event.key === "Delete" || event.key === "Backspace") {
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
        const hits = selections.filter((r) => r === selection || containsPoint(start, r.polygon)).reverse();
        const index = hits.findIndex((r) => r.drawingId === focusedId);
        const grabbed = hits[index] ?? selection;
        const clicked = index < 0 ? selection : hits[(index + 1) % hits.length];
        onFocus(grabbed.drawingId);
        event.currentTarget.setPointerCapture(event.pointerId);
        setGesture({
          target: event.currentTarget,
          pointerId: event.pointerId,
          start,
          clickId: clicked.drawingId,
          screen: { x: event.clientX, y: event.clientY },
          selection: grabbed,
          geometry,
        });
      },
      onPointerMove(event) {
        if (event.pointerId !== active?.pointerId) return;
        event.stopPropagation();
        setDraft(movedSelection(event));
      },
      onPointerUp(event) {
        if (event.pointerId !== active?.pointerId) return;
        event.stopPropagation();
        const next = movedSelection(event);
        cancel();
        if (next) onCommit(next);
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
  return { draft: active ? draft : null, handlersFor };
}
