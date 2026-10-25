import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useEditor, type Editor } from "tldraw";

const activePopups = new WeakMap<Editor, { owner: symbol; close: () => void }>();

export function useExclusivePopup(isOpen: boolean, close: () => void) {
  const editor = useEditor();
  const owner = useRef(Symbol("query popup"));
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    if (!isOpen && activePopups.get(editor)?.owner === owner.current) activePopups.delete(editor);
  }, [editor, isOpen]);

  useEffect(
    () => () => {
      if (activePopups.get(editor)?.owner === owner.current) activePopups.delete(editor);
    },
    [editor]
  );

  return useCallback(
    (anchor: HTMLElement) => {
      // Reading a popup should not open another layer from its highlighted text.
      if (anchor.closest("[data-sql-popup]")) return false;
      const previous = activePopups.get(editor);
      if (previous && previous.owner !== owner.current) previous.close();
      activePopups.set(editor, { owner: owner.current, close: () => closeRef.current() });
      return true;
    },
    [editor]
  );
}
