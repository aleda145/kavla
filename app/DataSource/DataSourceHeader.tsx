import { Editor } from "tldraw";
import EditableText from "../util/EditableText";
import { DataSourceShape } from "./data-source-types";

interface DataSourceHeaderProps {
  editor: Editor;
  shape: DataSourceShape;
}

export function DataSourceHeader({ editor, shape }: DataSourceHeaderProps) {
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
    </div>
  );
}
