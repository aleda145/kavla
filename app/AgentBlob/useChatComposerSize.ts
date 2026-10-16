import { useLayoutEffect, useRef, useState, type HTMLAttributes, type RefObject } from "react";

const MIN_HEIGHT = 58;

export function useChatComposerSize(panelRef: RefObject<HTMLElement | null>, isOpen: boolean, prompt: string) {
  const inputRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState(330);
  const [inputWidth, setInputWidth] = useState(0);
  const [inputHeight, setInputHeight] = useState(MIN_HEIGHT);
  const [requestedHeight, setRequestedHeight] = useState<number | null>(null);
  const [textareaHeight, setTextareaHeight] = useState(MIN_HEIGHT);
  const autoMaxHeight = Math.max(MIN_HEIGHT, Math.floor(panelHeight / 5));
  const maxHeight = Math.max(MIN_HEIGHT, Math.min(Math.floor(panelHeight * 0.65), panelHeight - 160));
  const manualHeight = requestedHeight === null ? null : Math.min(maxHeight, Math.max(MIN_HEIGHT, requestedHeight));

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const input = inputRef.current;
    if (!isOpen || !panel || !input) return;
    const measure = () => {
      setPanelHeight(panel.clientHeight);
      setInputWidth(input.clientWidth);
      setInputHeight(textareaRef.current?.clientHeight ?? input.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    observer.observe(input);
    return () => observer.disconnect();
  }, [isOpen, panelRef]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !isOpen) return;
    const scrollTop = textarea.scrollTop;
    textarea.style.height = "0px";
    const height = manualHeight ?? Math.min(autoMaxHeight, Math.max(MIN_HEIGHT, textarea.scrollHeight));
    textarea.style.height = `${height}px`;
    textarea.scrollTop = scrollTop;
    setTextareaHeight(height);
  }, [autoMaxHeight, inputWidth, isOpen, manualHeight, prompt]);

  const resizeHandleProps: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    tabIndex: 0,
    "aria-label": "Resize message input",
    "aria-orientation": "horizontal",
    "aria-valuemin": MIN_HEIGHT,
    "aria-valuemax": maxHeight,
    "aria-valuenow": Math.round(manualHeight ?? inputHeight),
    title: "Drag to resize. Double-click to fit text. Arrow keys resize; Home fits text.",
    style: {
      position: "absolute",
      top: -7,
      left: 0,
      right: 0,
      height: 12,
      cursor: "ns-resize",
      touchAction: "none",
      userSelect: "none",
      zIndex: 1,
    },
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        y: event.clientY,
        height: textareaRef.current?.clientHeight ?? inputRef.current?.clientHeight ?? MIN_HEIGHT,
      };
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      setRequestedHeight(Math.min(maxHeight, Math.max(MIN_HEIGHT, drag.height + drag.y - event.clientY)));
    },
    onPointerUp: (event) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      event.stopPropagation();
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => {
      dragRef.current = null;
    },
    onLostPointerCapture: () => {
      dragRef.current = null;
    },
    onDoubleClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      setRequestedHeight(null);
    },
    onKeyDown: (event) => {
      if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Home") setRequestedHeight(null);
      else
        setRequestedHeight(
          Math.min(
            maxHeight,
            Math.max(MIN_HEIGHT, (manualHeight ?? inputHeight) + (event.key === "ArrowUp" ? 16 : -16))
          )
        );
    },
  };

  return { inputRef, textareaRef, textareaHeight, manualHeight, autoMaxHeight, maxHeight, resizeHandleProps };
}
