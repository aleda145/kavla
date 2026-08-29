import { Asterisk } from "lucide-react";
import type { Editor } from "tldraw";
import EditableText from "../util/EditableText";
import type { SQLTextAreaShape } from "./sql-text-area-types";

interface SQLTextAreaHeaderProps {
  editor: Editor;
  shape: SQLTextAreaShape;
  onNameChange: (name: string) => void;
}

export function SQLTextAreaHeader({ editor, shape, onNameChange }: SQLTextAreaHeaderProps) {
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
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
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
      </div>
    </div>
  );
}
