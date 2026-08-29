import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, SyntheticEvent, WheelEvent } from "react";

const HOLD_TO_SCROLL_DELAY_MS = 500;

export type TldrawScrollAreaIndicatorState = {
  isVisible: boolean;
  clientX: number;
  clientY: number;
  holdDelayMs: number;
  sessionId: number;
};

const HIDDEN_INDICATOR: TldrawScrollAreaIndicatorState = {
  isVisible: false,
  clientX: 0,
  clientY: 0,
  holdDelayMs: HOLD_TO_SCROLL_DELAY_MS,
  sessionId: 0,
};

const stopNativePropagation = (event: Event) => {
  event.stopPropagation();
  if ("stopImmediatePropagation" in event) {
    event.stopImmediatePropagation();
  }
};

const stopReactPropagation = (event: SyntheticEvent) => {
  event.stopPropagation();
  if ("stopImmediatePropagation" in event.nativeEvent) {
    event.nativeEvent.stopImmediatePropagation();
  }
};

const isElementScrollable = (element: HTMLElement) =>
  element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;

type TldrawScrollAreaOptions = {
  requireScrollable?: boolean;
};

export function useTldrawScrollArea({ requireScrollable = true }: TldrawScrollAreaOptions = {}) {
  const ref = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [indicator, setIndicator] = useState<TldrawScrollAreaIndicatorState>(HIDDEN_INDICATOR);
  const isPointerActive = useRef(false);
  const canWheelScroll = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionId = useRef(0);
  const isHoldPending = useRef(false);

  const setRef = useCallback((node: HTMLElement | null) => {
    ref.current = node;
    setElement(node);
  }, []);

  const hideIndicator = useCallback(() => {
    setIndicator((prev) => (prev.isVisible ? { ...prev, isVisible: false } : prev));
  }, []);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const resetHold = useCallback(() => {
    clearHoverTimer();
    canWheelScroll.current = false;
    isHoldPending.current = false;
    hideIndicator();
  }, [clearHoverTimer, hideIndicator]);

  useEffect(() => {
    if (!element) return;

    const onPointerEnter = (event: globalThis.PointerEvent) => {
      if (requireScrollable && !isElementScrollable(element)) {
        resetHold();
        return;
      }

      clearHoverTimer();
      canWheelScroll.current = false;
      isHoldPending.current = true;

      if (event.pointerType !== "touch") {
        sessionId.current += 1;
        setIndicator({
          isVisible: true,
          clientX: event.clientX,
          clientY: event.clientY,
          holdDelayMs: HOLD_TO_SCROLL_DELAY_MS,
          sessionId: sessionId.current,
        });
      } else {
        hideIndicator();
      }

      hoverTimer.current = setTimeout(() => {
        canWheelScroll.current = true;
        isHoldPending.current = false;
        hideIndicator();
      }, HOLD_TO_SCROLL_DELAY_MS);
    };

    const onPointerLeave = () => {
      resetHold();
      isPointerActive.current = false;
    };

    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (!isHoldPending.current || event.pointerType === "touch") {
        return;
      }

      setIndicator((prev) =>
        prev.isVisible
          ? {
              ...prev,
              clientX: event.clientX,
              clientY: event.clientY,
            }
          : prev
      );
    };

    const stopProp = (event: Event) => {
      if (!canWheelScroll.current) return;
      stopNativePropagation(event);
    };

    element.addEventListener("pointerenter", onPointerEnter);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("touchstart", stopProp, { passive: false });
    element.addEventListener("touchmove", stopProp, { passive: false });
    element.addEventListener("wheel", stopProp, { passive: false });

    return () => {
      resetHold();
      element.removeEventListener("pointerenter", onPointerEnter);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("touchstart", stopProp);
      element.removeEventListener("touchmove", stopProp);
      element.removeEventListener("wheel", stopProp);
    };
  }, [clearHoverTimer, element, hideIndicator, requireScrollable, resetHold]);

  useEffect(() => {
    const handlePointerUp = () => {
      isPointerActive.current = false;
    };

    window.addEventListener("pointerup", handlePointerUp);
    return () => window.removeEventListener("pointerup", handlePointerUp);
  }, []);

  return {
    ref: setRef,
    indicator,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      isPointerActive.current = true;
      stopReactPropagation(event);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (!isPointerActive.current) return;
      stopReactPropagation(event);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      isPointerActive.current = false;
      stopReactPropagation(event);
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      isPointerActive.current = false;
      stopReactPropagation(event);
    },
    onWheel: (event: WheelEvent<HTMLElement>) => {
      if (!canWheelScroll.current) return;
      stopReactPropagation(event);
    },
  };
}
