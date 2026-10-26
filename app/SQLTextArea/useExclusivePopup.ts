import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useEditor, type Editor } from "tldraw";

type PopupKind = "hover" | "pinned";
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
      // Reading a popup should not open another layer from its highlighted text.
      if (anchor.closest("[data-sql-popup]")) return false;
      const slots = activePopups.get(editor) ?? {};
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
