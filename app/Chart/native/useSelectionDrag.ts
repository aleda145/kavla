import { useEffect, useState, type PointerEvent, type SVGProps } from "react";
import type { Editor } from "tldraw";
import type { ChartData } from "./chart-data";
import { selectionRegion, translateSelection, type chartGeometry } from "./geometry";
import type { ChartSelection, Point } from "./selection";

type Geometry = ReturnType<typeof chartGeometry>;
type PolygonEvent = PointerEvent<SVGPolygonElement>;

function plotPoint(event: PolygonEvent, geometry: Geometry): Point {
  const transform = event.currentTarget.getScreenCTM()!;
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
  return geometry.toAnalytical(local);
}

export function useSelectionDrag(
  editor: Editor,
  selection: ChartSelection | null,
  polygon: Point[] | null,
  geometry: Geometry | null,
  data: ChartData | null,
  color: string | null,
  onCommit: (next: ChartSelection) => void
) {
  const [gesture, setGesture] = useState<{
    target: SVGPolygonElement;
    pointerId: number;
    start: Point;
    selection: ChartSelection;
    geometry: Geometry;
  } | null>(null);
  const [draft, setDraft] = useState<ChartSelection | null>(null);
  const active = gesture && gesture.selection === selection && gesture.geometry === geometry ? gesture : null;

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
    if (!active || !selection || !geometry || !data || !polygon) return null;
    const moved = translateSelection(polygon, active.start, plotPoint(event, geometry), geometry.plot);
    return moved && { ...selection, ...selectionRegion(data, geometry, moved, color) };
  }

  const handlers: SVGProps<SVGPolygonElement> | undefined =
    selection && geometry && polygon
      ? {
          style: { pointerEvents: "all", touchAction: "none", cursor: active ? "grabbing" : "grab" },
          onPointerDown(event) {
            if (!event.isPrimary || event.button !== 0 || editor.inputs.isPanning || active) return;
            event.stopPropagation();
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setGesture({
              target: event.currentTarget,
              pointerId: event.pointerId,
              start: plotPoint(event, geometry),
              selection,
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
        }
      : undefined;
  return { draft: active ? draft : null, handlers };
}
