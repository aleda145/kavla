import { EditorView } from "@codemirror/view";

export function applyTooltipPlacementStyle(
  view: EditorView,
  pos: number,
  el: HTMLElement,
  additionalMargin = 8,
  zIndex = "1000000"
): void {
  const textRect = view.coordsAtPos(pos);
  const shapeEl = view.dom.closest('[id^="shape:"]') as HTMLElement;
  const tooltipWrapper = el.closest(".cm-tooltip") as HTMLElement;

  const targetEl = tooltipWrapper || el;

  const applyStyles = () => {
    targetEl.style.setProperty("position", "fixed", "important");
    targetEl.style.setProperty("z-index", zIndex, "important");

    // Keep CodeMirror's native stacking for shared tooltip wrappers.
    if (targetEl === tooltipWrapper) {
      targetEl.style.display = "flex";
      targetEl.style.flexDirection = "column";
      targetEl.style.alignItems = "flex-start";
      targetEl.style.gap = "8px";
      targetEl.style.setProperty("transform", "none", "important");
    }

    targetEl.style.setProperty("top", "auto", "important");
    targetEl.style.setProperty("bottom", "auto", "important");
    targetEl.style.setProperty("left", "auto", "important");
    targetEl.style.setProperty("right", "auto", "important");

    if (!textRect || !shapeEl) {
      if (textRect) {
        targetEl.style.setProperty("left", `${textRect.right + additionalMargin}px`, "important");
        targetEl.style.setProperty("top", `${textRect.top}px`, "important");
      } else {
        targetEl.style.setProperty("left", "100%", "important");
        targetEl.style.setProperty("top", "0", "important");
      }
      return;
    }

    const shapeRect = shapeEl.getBoundingClientRect();

    const distTop = Math.abs(textRect.top - shapeRect.top);
    const distBottom = Math.abs(shapeRect.bottom - textRect.bottom);
    const distLeft = Math.abs(textRect.left - shapeRect.left);
    const distRight = Math.abs(shapeRect.right - textRect.right);

    const minDist = Math.min(distTop, distBottom, distLeft, distRight);

    if (minDist === distTop) {
      targetEl.style.setProperty("bottom", `${window.innerHeight - shapeRect.top + additionalMargin}px`, "important");
      targetEl.style.setProperty("left", `${shapeRect.left}px`, "important");
    } else if (minDist === distBottom) {
      targetEl.style.setProperty("top", `${shapeRect.bottom + additionalMargin}px`, "important");
      targetEl.style.setProperty("left", `${shapeRect.left}px`, "important");
    } else if (minDist === distLeft) {
      targetEl.style.setProperty("right", `${window.innerWidth - shapeRect.left + additionalMargin}px`, "important");
      targetEl.style.setProperty("top", `${shapeRect.top}px`, "important");
    } else {
      targetEl.style.setProperty("left", `${shapeRect.right + additionalMargin}px`, "important");
      targetEl.style.setProperty("top", `${shapeRect.top}px`, "important");
    }
  };

  applyStyles();

  // CodeMirror rewrites tooltip styles on scroll and document changes.
  if (!(targetEl as any)._hasPositionObserver) {
    (targetEl as any)._hasPositionObserver = true;

    const observer = new MutationObserver((_mutations) => {
      observer.disconnect();
      applyStyles();
      observer.observe(targetEl, { attributes: true, attributeFilter: ["style"] });
    });

    observer.observe(targetEl, { attributes: true, attributeFilter: ["style"] });

    const cleanupObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.removedNodes.forEach((node) => {
          if (node === targetEl || targetEl.contains(node)) {
            observer.disconnect();
            cleanupObserver.disconnect();
          }
        });
      });
    });

    if (targetEl.parentElement) {
      cleanupObserver.observe(targetEl.parentElement, { childList: true, subtree: true });
    } else {
      cleanupObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
}
