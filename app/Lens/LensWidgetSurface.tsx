import type { ReactNode } from "react";
import { TldrawScrollAreaIndicator } from "../DataSource/TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "../DataSource/useTldrawScrollArea";
import { stopLensWidgetEventPropagation } from "./lens-events";

interface LensWidgetSurfaceProps {
  children: ReactNode;
}

export function LensWidgetSurface({ children }: LensWidgetSurfaceProps) {
  const scrollArea = useTldrawScrollArea({ requireScrollable: false });

  return (
    <div
      ref={scrollArea.ref}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "all",
        touchAction: "auto",
        userSelect: "auto",
      }}
      onPointerDown={scrollArea.onPointerDown}
      onPointerMove={scrollArea.onPointerMove}
      onPointerUp={scrollArea.onPointerUp}
      onPointerCancel={scrollArea.onPointerCancel}
      onMouseDown={stopLensWidgetEventPropagation}
      onMouseMove={stopLensWidgetEventPropagation}
      onMouseUp={stopLensWidgetEventPropagation}
      onClick={stopLensWidgetEventPropagation}
      onDoubleClick={stopLensWidgetEventPropagation}
      onContextMenu={stopLensWidgetEventPropagation}
      onWheel={scrollArea.onWheel}
      onTouchStart={stopLensWidgetEventPropagation}
      onTouchMove={stopLensWidgetEventPropagation}
      onTouchEnd={stopLensWidgetEventPropagation}
      onKeyDown={stopLensWidgetEventPropagation}
      onKeyUp={stopLensWidgetEventPropagation}
    >
      {children}
      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />
    </div>
  );
}
