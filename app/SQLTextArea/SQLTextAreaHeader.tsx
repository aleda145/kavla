import { Asterisk, BriefcaseBusiness, Code2, Scan } from "lucide-react";
import { type Editor, useToasts, useValue } from "tldraw";
import EditableText from "../util/EditableText";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { setQueryBizMode, useBizMode } from "../client/canvas/bizMode";
import { fitQueryNodes } from "../client/canvas/fitQueryNodes";
import { getLayoutInProgress } from "../client/canvas/layoutActions";

interface SQLTextAreaHeaderProps {
  editor: Editor;
  shape: SQLTextAreaShape;
  onNameChange: (name: string) => void;
}

export function SQLTextAreaHeader({ editor, shape, onNameChange }: SQLTextAreaHeaderProps) {
  const bizMode = useBizMode(editor, shape.id);
  const { addToast } = useToasts();
  const canFit = useValue(
    "Can fit query",
    () => !editor.getIsReadonly() && !editor.isShapeOrAncestorLocked(shape.id) && !getLayoutInProgress(editor).get(),
    [editor, shape.id]
  );
  return (
    <div
      style={{
        padding: "8px 12px",
        fontWeight: 800,
        borderBottom: "4px solid #000",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "#fef9c3",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      }}
    >
      <EditableText text={shape.props.name} onSave={onNameChange} editor={editor} shapeId={shape.id} />
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
        {shape.props.isDirty && (
          <span
            title="Query has been updated and not yet run"
            style={{ color: "#d97706", fontSize: 12, fontWeight: "bold" }}
          >
            <Asterisk size={12} />
          </span>
        )}
        {shape.props.stale && (
          <span title="Upstream source changed" style={{ color: "#d97706", fontSize: 12, fontWeight: "bold" }}>
            ⚠️ STALE
          </span>
        )}
        <button
          type="button"
          aria-label="Fit this query to its content"
          title="Fit this query to its content"
          disabled={!canFit}
          onClick={() => {
            if (!canFit) return;
            try {
              fitQueryNodes(editor, [shape.id]);
            } catch (error) {
              addToast({
                title: "Could not resize query",
                description: error instanceof Error ? error.message : String(error),
                severity: "error",
              });
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-6 w-7 items-center justify-center rounded border-2 border-black bg-white p-0 text-black shadow-none cursor-pointer enabled:hover:bg-slate-200 disabled:cursor-default disabled:opacity-40 active:translate-x-px active:translate-y-px active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
        >
          <Scan size={14} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Biz mode for this query"
          aria-pressed={bizMode}
          title={bizMode ? "Biz mode · click to show SQL" : "SQL mode · click to show Biz flow"}
          onClick={() => setQueryBizMode(editor, shape.id, !bizMode)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-6 w-7 items-center justify-center rounded border-2 border-black bg-white p-0 text-black shadow-none cursor-pointer aria-pressed:translate-x-px aria-pressed:translate-y-px aria-pressed:shadow-none active:translate-x-px active:translate-y-px active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
        >
          {bizMode ? <BriefcaseBusiness size={14} aria-hidden /> : <Code2 size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
