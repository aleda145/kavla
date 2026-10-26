import { useLayoutEffect, useState, type RefObject } from "react";
import { useEditor, type TLShapeId } from "tldraw";

type Rect = { left: number; top: number; right: number; bottom: number };

function overlap(a: Rect, b: Rect) {
  return (
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  );
}

export function findPopupPosition(
  anchor: Rect,
  width: number,
  height: number,
  obstacles: Rect[],
  viewport: { w: number; h: number },
  preferred?: Rect
) {
  const gap = 8;
  const maxLeft = Math.max(gap, viewport.w - width - gap);
  const maxTop = Math.max(gap, viewport.h - height - gap);
  let best = { left: gap, top: gap };
  let bestOverlap = Infinity;
  let bestDistance = Infinity;
  let bestInside = false;
  const evaluate = (x: number, y: number) => {
    const left = Math.max(gap, Math.min(x, maxLeft));
    const top = Math.max(gap, Math.min(y, maxTop));
    const rect = { left, top, right: left + width, bottom: top + height };
    const inside = Boolean(
      preferred &&
      left >= preferred.left + gap &&
      top >= preferred.top + gap &&
      rect.right <= preferred.right - gap &&
      rect.bottom <= preferred.bottom - gap
    );
    // Never prefer covering the word or card that opened the popup.
    const covered = overlap(rect, anchor) * 4 + obstacles.reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0);
    const dx = Math.max(0, anchor.left - rect.right, rect.left - anchor.right);
    const dy = Math.max(0, anchor.top - rect.bottom, rect.top - anchor.bottom);
    const distance = dx * dx + dy * dy + 0.01 * ((left - anchor.left) ** 2 + (top - anchor.top) ** 2);
    if (
      covered < bestOverlap ||
      (covered === bestOverlap && ((inside && !bestInside) || (inside === bestInside && distance < bestDistance)))
    ) {
      best = { left, top };
      bestOverlap = covered;
      bestDistance = distance;
      bestInside = inside;
    }
  };
  const consider = (x: number, y: number) => {
    evaluate(x, y);
    if (
      preferred &&
      width + gap * 2 <= preferred.right - preferred.left &&
      height + gap * 2 <= preferred.bottom - preferred.top
    ) {
      evaluate(
        Math.max(preferred.left + gap, Math.min(x, preferred.right - width - gap)),
        Math.max(preferred.top + gap, Math.min(y, preferred.bottom - height - gap))
      );
    }
  };

  // Try nearby gaps on every side of the trigger and visible nodes, then viewport edges.
  for (const rect of [anchor, ...obstacles]) {
    for (const top of [anchor.top, rect.top, rect.bottom - height]) {
      consider(rect.right + gap, top);
      consider(rect.left - width - gap, top);
    }
    for (const left of [anchor.left, rect.left, rect.right - width]) {
      consider(left, rect.bottom + gap);
      consider(left, rect.top - height - gap);
    }
  }
  for (const left of [gap, maxLeft, anchor.left]) {
    for (const top of [gap, maxTop, anchor.top]) consider(left, top);
  }
  return best;
}

export function usePopupPlacement(
  anchor: HTMLElement | null,
  popup: RefObject<HTMLDivElement | null>,
  ownerShapeId: TLShapeId
) {
  const editor = useEditor();
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const element = popup.current;
    if (!anchor || !element) return;
    let frame = 0;
    const place = () => {
      if (!anchor.isConnected) return;
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const screen = { left: 0, top: 0, right: viewport.w, bottom: viewport.h };
      const obstacles: Rect[] = [];
      const owner = document.getElementById(ownerShapeId);
      const ownerBounds = owner?.getBoundingClientRect();
      // Only the current query's cards constrain placement; other shapes may be covered.
      for (const card of owner?.querySelectorAll<HTMLElement>("[data-sql-biz-card]") ?? []) {
        const rect = card.getBoundingClientRect();
        if (overlap(rect, screen)) obstacles.push(rect);
      }
      const rect = element.getBoundingClientRect();
      const next = findPopupPosition(
        anchor.getBoundingClientRect(),
        rect.width,
        rect.height,
        obstacles,
        viewport,
        ownerBounds
      );
      setPosition((previous) => (previous.left === next.left && previous.top === next.top ? previous : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const unsubscribe = editor.store.listen(schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchor, popup, editor, ownerShapeId]);

  return position;
}
