import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TldrawScrollAreaIndicatorState } from "./useTldrawScrollArea";

const CHIP_WIDTH = 12;
const CHIP_HEIGHT = 36;
const LABEL_WIDTH = 36;
const LABEL_HEIGHT = 22;
const GAP = 4;
const CHIP_OFFSET_X = 12;
const CHIP_OFFSET_Y = 16;
const VIEWPORT_PADDING = 12;
const CONTAINER_WIDTH = CHIP_WIDTH + GAP + LABEL_WIDTH;
const CONTAINER_HEIGHT = Math.max(CHIP_HEIGHT, LABEL_HEIGHT);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

type TldrawScrollAreaIndicatorProps = {
  indicator: TldrawScrollAreaIndicatorState;
};

export function TldrawScrollAreaIndicator({ indicator }: TldrawScrollAreaIndicatorProps) {
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (!indicator.isVisible) {
      setIsAnimating(false);
      return;
    }

    setIsAnimating(false);
    const frame = window.requestAnimationFrame(() => {
      setIsAnimating(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [indicator.isVisible, indicator.sessionId]);

  if (!indicator.isVisible || typeof document === "undefined") {
    return null;
  }

  const left = clamp(
    indicator.clientX + CHIP_OFFSET_X,
    VIEWPORT_PADDING,
    Math.max(VIEWPORT_PADDING, window.innerWidth - CONTAINER_WIDTH - VIEWPORT_PADDING)
  );
  const top = clamp(
    indicator.clientY + CHIP_OFFSET_Y,
    VIEWPORT_PADDING,
    Math.max(VIEWPORT_PADDING, window.innerHeight - CONTAINER_HEIGHT - VIEWPORT_PADDING)
  );

  return createPortal(
    <div
      style={{
        position: "fixed",
        left,
        top,
        display: "flex",
        alignItems: "center",
        gap: GAP,
        pointerEvents: "none",
        zIndex: 999999,
      }}
    >
      <div
        style={{
          position: "relative",
          width: CHIP_WIDTH,
          height: CHIP_HEIGHT,
          border: "2px solid #000",
          borderRadius: 999,
          backgroundColor: "#000",
          boxShadow: "3px 3px 0px 0px rgb(0,0,0)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: isAnimating ? "100%" : "0%",
            backgroundColor: "#fde047",
            transition: `height ${indicator.holdDelayMs}ms linear`,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          minWidth: LABEL_WIDTH,
          color: "#7c3aed",
          fontSize: 10,
          fontWeight: 900,
          lineHeight: 0.95,
          textTransform: "uppercase",
          userSelect: "none",
        }}
      >
        <span>Enable</span>
        <span>Scroll</span>
      </div>
    </div>,
    document.body
  );
}
