import { Asterisk, BriefcaseBusiness, Code2 } from "lucide-react";
import type { Editor } from "tldraw";
import EditableText from "../util/EditableText";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { setQueryBizMode, useBizMode } from "../client/canvas/bizMode";

interface SQLTextAreaHeaderProps {
  editor: Editor;
  shape: SQLTextAreaShape;
  onNameChange: (name: string) => void;
}

export function SQLTextAreaHeader({ editor, shape, onNameChange }: SQLTextAreaHeaderProps) {
  const bizMode = useBizMode(editor, shape.id);
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
          aria-label="Biz mode for this query"
          aria-pressed={bizMode}
          title={bizMode ? "Biz mode · click to show SQL" : "SQL mode · click to show Biz flow"}
          onClick={() => setQueryBizMode(editor, shape.id, !bizMode)}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-6 w-7 items-center justify-center rounded border-2 border-black bg-teal-100 p-0 text-black shadow-[2px_2px_0_#000] cursor-pointer hover:bg-teal-200 aria-pressed:bg-teal-200 aria-pressed:translate-x-px aria-pressed:translate-y-px aria-pressed:shadow-none active:translate-x-px active:translate-y-px active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
        >
          {bizMode ? <BriefcaseBusiness size={14} aria-hidden /> : <Code2 size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
