import type { Editor } from "tldraw";

export function enableRightClickDragPan(editor: Editor): () => void {
  const container = editor.getContainer();
  const dragThreshold = Math.sqrt(editor.options.dragDistanceSquared);
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const rightDragCursorClass = "kavla-right-click-panning";
  const cursorStyle = ownerDocument.createElement("style");
  cursorStyle.textContent = `
    .${rightDragCursorClass},
    .${rightDragCursorClass} * {
      cursor: var(--tl-cursor-grabbing) !important;
    }
  `;
  ownerDocument.head.appendChild(cursorStyle);

  let isRightPointerDown = false;
  let hasRightDragged = false;
  let shouldSwallowTrustedContextMenu = false;
  let activePointerId: number | null = null;
  let clearContextMenuSwallowTimeout: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let previousCursorType: ReturnType<Editor["getInstanceState"]>["cursor"]["type"] | null = null;

  const clearContextMenuSwallowLater = () => {
    if (clearContextMenuSwallowTimeout) {
      ownerWindow.clearTimeout(clearContextMenuSwallowTimeout);
    }
    clearContextMenuSwallowTimeout = ownerWindow.setTimeout(() => {
      shouldSwallowTrustedContextMenu = false;
      clearContextMenuSwallowTimeout = null;
    }, 250);
  };

  const stopRightClickEvent = (event: PointerEvent | MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const releasePointerCapture = () => {
    if (activePointerId === null) {
      return;
    }

    if (container.hasPointerCapture(activePointerId)) {
      container.releasePointerCapture(activePointerId);
    }
    activePointerId = null;
  };

  const dispatchRightClick = (event: PointerEvent) => {
    editor.dispatch({
      type: "pointer",
      target: "canvas",
      name: "right_click",
      point: {
        x: event.clientX,
        y: event.clientY,
        z: event.pressure,
      },
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.metaKey || event.ctrlKey,
      metaKey: event.metaKey,
      accelKey: event.metaKey || event.ctrlKey,
      pointerId: event.pointerId,
      button: 2,
      isPen: event.pointerType === "pen",
    });
  };

  const dispatchSyntheticContextMenu = (event: PointerEvent) => {
    const canvas = container.querySelector<HTMLDivElement>(".tl-canvas") ?? container;
    canvas.dispatchEvent(
      new PointerEvent("contextmenu", {
        bubbles: true,
        clientX: event.clientX,
        clientY: event.clientY,
        button: 2,
        buttons: 0,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
      })
    );
  };

  const resetRightPointerState = () => {
    isRightPointerDown = false;
    hasRightDragged = false;
    if (previousCursorType) {
      editor.setCursor({ type: previousCursorType, rotation: 0 });
      previousCursorType = null;
    }
    container.classList.remove(rightDragCursorClass);
    releasePointerCapture();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (event.isTrusted && (shouldSwallowTrustedContextMenu || hasRightDragged)) {
      stopRightClickEvent(event);
      clearContextMenuSwallowLater();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 2 || !container.contains(event.target as Node)) {
      return;
    }

    isRightPointerDown = true;
    hasRightDragged = false;
    shouldSwallowTrustedContextMenu = true;
    activePointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    lastX = event.clientX;
    lastY = event.clientY;
    editor.menus.clearOpenMenus();
    container.setPointerCapture(event.pointerId);
    stopRightClickEvent(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!isRightPointerDown || event.pointerId !== activePointerId) {
      return;
    }

    const totalDx = event.clientX - startX;
    const totalDy = event.clientY - startY;

    if (!hasRightDragged) {
      if (totalDx * totalDx + totalDy * totalDy < dragThreshold * dragThreshold) {
        stopRightClickEvent(event);
        return;
      }

      hasRightDragged = true;
      previousCursorType = editor.getInstanceState().cursor.type;
      editor.setCursor({ type: "grabbing", rotation: 0 });
      container.classList.add(rightDragCursorClass);
      editor.menus.clearOpenMenus();
    }

    const dx = hasRightDragged && lastX === startX && lastY === startY ? totalDx : event.clientX - lastX;
    const dy = hasRightDragged && lastX === startX && lastY === startY ? totalDy : event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    const { x, y, z } = editor.getCamera();
    editor.setCamera({ x: x + dx / z, y: y + dy / z, z }, { immediate: true });
    stopRightClickEvent(event);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!isRightPointerDown || event.button !== 2 || event.pointerId !== activePointerId) {
      return;
    }

    stopRightClickEvent(event);

    if (hasRightDragged) {
      resetRightPointerState();
      clearContextMenuSwallowLater();
      return;
    }

    dispatchRightClick(event);
    resetRightPointerState();
    dispatchSyntheticContextMenu(event);
    clearContextMenuSwallowLater();
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) {
      return;
    }

    resetRightPointerState();
    clearContextMenuSwallowLater();
  };

  ownerDocument.addEventListener("contextmenu", onContextMenu, { capture: true });
  ownerDocument.addEventListener("pointerdown", onPointerDown, { capture: true });
  ownerWindow.addEventListener("pointermove", onPointerMove, { capture: true });
  ownerWindow.addEventListener("pointerup", onPointerUp, { capture: true });
  ownerWindow.addEventListener("pointercancel", onPointerCancel, { capture: true });

  return () => {
    if (clearContextMenuSwallowTimeout) {
      ownerWindow.clearTimeout(clearContextMenuSwallowTimeout);
    }
    releasePointerCapture();
    container.classList.remove(rightDragCursorClass);
    cursorStyle.remove();
    ownerDocument.removeEventListener("contextmenu", onContextMenu, { capture: true });
    ownerDocument.removeEventListener("pointerdown", onPointerDown, { capture: true });
    ownerWindow.removeEventListener("pointermove", onPointerMove, { capture: true });
    ownerWindow.removeEventListener("pointerup", onPointerUp, { capture: true });
    ownerWindow.removeEventListener("pointercancel", onPointerCancel, { capture: true });
  };
}
