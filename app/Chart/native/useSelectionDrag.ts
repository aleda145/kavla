import { useEffect, useState, type PointerEvent, type SVGAttributes } from "react";
import { getCursor, type Editor, type TLCursorType } from "tldraw";
import type { ChartData } from "./chart-data";
import {
  resizeSelection,
  rotateSelection,
  rotationCenter,
  selectionRegion,
  translateSelection,
  type chartGeometry,
  type ResizeHandle,
  type RotationHandle,
  type SelectionHandle,
} from "./geometry";
import { selectsPoint, type ChartSelection, type Point } from "./selection";

type Geometry = ReturnType<typeof chartGeometry>;
type DrawingEvent = PointerEvent<SVGGraphicsElement>;

const cursors = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  "rotate-nw": "nwse-rotate",
  "rotate-ne": "nesw-rotate",
  "rotate-se": "senw-rotate",
  "rotate-sw": "swne-rotate",
} satisfies Record<SelectionHandle, TLCursorType>;

function isRotationHandle(handle?: SelectionHandle): handle is RotationHandle {
  return handle?.startsWith("rotate-") === true;
}

function plotPoint(event: DrawingEvent, geometry: Geometry): Point {
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
  chartRotation: number,
  focusedId: string | null,
  onFocus: (drawingId: string | null) => void,
  onDelete: (drawingId: string) => void,
  onCommit: (next: ChartSelection) => void
) {
  const [gesture, setGesture] = useState<{
    target: SVGGraphicsElement;
    pointerId: number;
    start: Point;
    screen: Point;
    clickId: string;
    handle?: SelectionHandle;
    center?: Point;
    selection: ChartSelection;
    geometry: Geometry;
  } | null>(null);
  const [draft, setDraft] = useState<{
    selection: ChartSelection;
    handle?: ResizeHandle;
  } | null>(null);
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

  function editedSelection(event: DrawingEvent) {
    if (!active || !geometry || !data) return null;
    if (Math.hypot(event.clientX - active.screen.x, event.clientY - active.screen.y) < 3) return null;
    const selection = active.selection;
    const end = plotPoint(event, geometry);
    let polygon: Point[] | null | undefined;
    let handle: ResizeHandle | undefined;
    if (isRotationHandle(active.handle)) {
      const center = active.center;
      if (!center) return null;
      const start = geometry.fromAnalytical(active.start);
      const pointer = geometry.fromAnalytical(end);
      const dx = pointer.x - center.x;
      const dy = pointer.y - center.y;
      if (Math.hypot(dx, dy) < 1) return null;
      let angle = Math.atan2(dy, dx) - Math.atan2(start.y - center.y, start.x - center.x);
      if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      if (Math.abs(Math.sin(angle / 2)) < 1e-10) return null;
      polygon = rotateSelection(selection.polygon, geometry, center, angle);
    } else if (active.handle) {
      const resize = resizeSelection(
        selection.polygon,
        active.handle,
        { x: end.x - active.start.x, y: end.y - active.start.y },
        geometry.plot
      );
      polygon = resize?.polygon;
      handle = resize?.handle;
    } else {
      polygon = translateSelection(selection.polygon, active.start, end, geometry.plot, selection.inverted);
    }
    if (!polygon) return null;
    return {
      selection: { ...selection, ...selectionRegion(data, geometry, polygon, color, selection.inverted) },
      handle,
    };
  }

  function handlersFor(
    selection: ChartSelection,
    index: number,
    handle?: SelectionHandle
  ): SVGAttributes<SVGGraphicsElement> {
    const cursorHandle = active?.handle === handle ? (draft?.handle ?? handle) : handle;
    return {
      tabIndex: 0,
      role: "button",
      "aria-label": isRotationHandle(handle)
        ? `Rotate drawing ${index + 1} (${handle.slice(7).toUpperCase()})`
        : handle
          ? `Resize drawing ${index + 1} (${handle.toUpperCase()})`
          : `Select drawing ${index + 1}`,
      style: {
        pointerEvents: "all",
        touchAction: "none",
        cursor: cursorHandle ? getCursor(cursors[cursorHandle], chartRotation) : active ? "grabbing" : "grab",
      },
      onFocus: () => onFocus(selection.drawingId),
      onKeyDown(event) {
        if (handle && geometry && data && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          if (active) return;
          if (isRotationHandle(handle)) {
            const clockwise = event.key === "ArrowRight" || event.key === "ArrowDown";
            const angle = ((clockwise ? 1 : -1) * (event.shiftKey ? 15 : 1) * Math.PI) / 180;
            const center = rotationCenter(selection.polygon, geometry);
            const polygon = rotateSelection(selection.polygon, geometry, center, angle);
            if (polygon)
              onCommit({ ...selection, ...selectionRegion(data, geometry, polygon, color, selection.inverted) });
            return;
          }
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
            onCommit({ ...selection, ...selectionRegion(data, geometry, resize.polygon, color, selection.inverted) });
            if (resize.handle !== handle) {
              event.currentTarget
                .closest("[data-chart-drawing]")
                ?.querySelector<SVGGraphicsElement>(`[data-resize-handle="${resize.handle}"]`)
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
          const hits = selections.filter((r) => r === selection || selectsPoint(start, r)).reverse();
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
          center: isRotationHandle(handle) ? rotationCenter(grabbed.polygon, geometry) : undefined,
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
  return {
    draft: active ? draft?.selection : null,
    action: isRotationHandle(active?.handle) ? "Rotating" : active?.handle ? "Resizing" : "Moving",
    handlersFor,
  };
}
