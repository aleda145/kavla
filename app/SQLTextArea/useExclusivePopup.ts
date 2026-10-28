import { createContext, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useEditor, type Editor } from "tldraw";

export const SQLPopupHoverContext = createContext<{ onPointerEnter: () => void; onPointerLeave: () => void } | null>(
  null
);

type PopupKind = "hover" | "pinned" | "identifier";
type Popup = { owner: symbol; close: () => void };
const activePopups = new WeakMap<Editor, Partial<Record<PopupKind, Popup>>>();

export function useExclusivePopup(isOpen: boolean, close: () => void, kind: PopupKind = "hover") {
  const editor = useEditor();
  const owner = useRef(Symbol("query popup"));
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    const slots = activePopups.get(editor);
    if (!isOpen && slots?.[kind]?.owner === owner.current) delete slots[kind];
  }, [editor, isOpen, kind]);

  useEffect(
    () => () => {
      const slots = activePopups.get(editor);
      if (slots?.[kind]?.owner === owner.current) delete slots[kind];
    },
    [editor, kind]
  );

  return useCallback(
    (anchor: HTMLElement) => {
      // Operation panels can open column details without replacing their parent.
      // Other popups cannot start additional nested layers.
      const parent = anchor.closest("[data-sql-popup]");
      if (parent && (kind !== "identifier" || !parent.hasAttribute("data-sql-biz-popup"))) return false;
      const slots = activePopups.get(editor) ?? {};
      if (kind !== "identifier") {
        slots.identifier?.close();
        delete slots.identifier;
      } else if (!parent) {
        slots.hover?.close();
        delete slots.hover;
      }
      const previous = slots[kind];
      if (previous && previous.owner !== owner.current) previous.close();
      if (kind === "pinned") {
        slots.hover?.close();
        delete slots.hover;
      }
      slots[kind] = { owner: owner.current, close: () => closeRef.current() };
      activePopups.set(editor, slots);
      return true;
    },
    [editor, kind]
  );
}
