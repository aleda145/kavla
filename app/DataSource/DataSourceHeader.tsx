import { Editor } from "tldraw";
import EditableText from "../util/EditableText";
import { DataSourceShape } from "./data-source-types";
import { AlertCircle, Loader2 } from "lucide-react";
import type { CliSource } from "../client/useLocalServer";

interface DataSourceHeaderProps {
  editor: Editor;
  shape: DataSourceShape;
  source?: CliSource;
}

export function DataSourceHeader({ editor, shape, source }: DataSourceHeaderProps) {
  return (
    <div
      style={{
        padding: "8px 12px",
        fontWeight: 800,
        borderBottom: "4px solid #000",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "#dbeafe", // bg-blue-100
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      }}
    >
      <EditableText
        text={shape.props.name}
        onSave={(name) =>
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            props: { name },
          })
        }
        editor={editor}
        shapeId={shape.id}
      />
      {source?.loading ? (
        <span
          role="status"
          title="Browse or query to connect this source"
          className="flex shrink-0 items-center gap-1 text-[10px] normal-case"
        >
          <Loader2 aria-hidden="true" size={14} className="animate-spin" /> Loading…
        </span>
      ) : source?.available === false ? (
        <span
          role="status"
          title={source.error}
          className="flex shrink-0 items-center gap-1 text-[10px] normal-case text-red-700"
        >
          <AlertCircle aria-hidden="true" size={14} /> Unavailable
        </span>
      ) : null}
    </div>
  );
}
