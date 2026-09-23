import { useEffect, type RefObject } from "react";
import { createShapeId, type Editor, type TLUiToastsContextType } from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import { ingestLocalDataSourceFile } from "../../DataSource/ingestLocalDataSourceFile";
import { toValidSqlName } from "../../util/sql";

export function useCanvasFileDrop(
  editorRef: RefObject<Editor | null>,
  addToast: TLUiToastsContextType["addToast"]
): void {
  useEffect(() => {
    const handleDrop = async (event: DragEvent) => {
      const editor = editorRef.current;
      if (!editor || editor.getInstanceState().isReadonly || !event.dataTransfer?.files?.length) {
        return;
      }

      const files = Array.from(event.dataTransfer.files).filter((file) =>
        /\.(csv|parquet|json|ndjson)$/i.test(file.name)
      );
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
      const otherFiles = Array.from(event.dataTransfer.files).filter((file) => !files.includes(file));
      if (otherFiles.length) {
        void editor.putExternalContent({ type: "files", files: otherFiles, point }).catch((error) => {
          addToast({
            title: "Could not add canvas files",
            description: error instanceof Error ? error.message : String(error),
            severity: "error",
          });
        });
      }
      for (const [index, file] of files.entries()) {
        const shapeId = createShapeId();
        const baseName = file.name.split(".")[0];

        editor.createShape<DataSourceShape>({
          id: shapeId,
          type: "data-source",
          x: point.x + index * 40,
          y: point.y + index * 40,
          props: {
            filename: `Processing ${file.name}...`,
            name: toValidSqlName(baseName),
            isRunning: true,
            error: null,
          },
        });

        try {
          const props = await ingestLocalDataSourceFile(editor, shapeId, file);

          const currentShape = editor.getShape<DataSourceShape>(shapeId);
          if (currentShape) {
            editor.updateShape<DataSourceShape>({
              id: shapeId,
              type: "data-source",
              props,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Failed to process dropped file", error);
          editor.updateShape<DataSourceShape>({
            id: shapeId,
            type: "data-source",
            props: {
              error: `Failed to load file: ${message}`,
              isRunning: false,
              filename: file.name,
            },
          });
        }
      }
    };

    const handleDragOver = (event: DragEvent) => {
      // Browsers require this to permit a drop. Propagation stays intact for tldraw.
      event.preventDefault();
    };

    window.addEventListener("drop", handleDrop, { capture: true });
    window.addEventListener("dragover", handleDragOver, { capture: true });

    return () => {
      window.removeEventListener("drop", handleDrop, { capture: true });
      window.removeEventListener("dragover", handleDragOver, { capture: true });
    };
  }, [addToast, editorRef]);
}
