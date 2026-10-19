import { Unplug, TriangleAlert } from "lucide-react";
import { useValue, type Editor, type TLShapeId } from "tldraw";
import { getShapeQueryStatus } from "./shapeQueryStatus";

export function ShapeStatusTabs({ editor, shapeId }: { editor: Editor; shapeId: TLShapeId }) {
  const status = useValue("shape query status", () => getShapeQueryStatus(editor, shapeId), [editor, shapeId]);
  if (!status) return null;
  const orphaned = status === "orphaned";
  const title = orphaned
    ? "An upstream shape was removed. Restore it, or update the query's inputs and run it again."
    : "An upstream query was rerun. Rerun the affected query to refresh these results.";
  const Icon = orphaned ? Unplug : TriangleAlert;
  return (
    <div
      style={{ position: "absolute", top: -40, right: 12, display: "flex", flexDirection: "row-reverse", zIndex: 0 }}
    >
      <div
        role="status"
        title={title}
        aria-label={`${orphaned ? "Orphaned" : "Stale"}: ${title}`}
        tabIndex={0}
        style={{
          height: 40,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          border: "2px solid #000",
          borderTopLeftRadius: 10,
          borderTopRightRadius: 10,
          backgroundColor: orphaned ? "#fecaca" : "#fde047",
          color: "#000",
          fontSize: 11,
          fontWeight: 800,
          textTransform: "uppercase",
          cursor: "help",
          whiteSpace: "nowrap",
        }}
      >
        <Icon size={16} aria-hidden="true" />
        {orphaned ? "Orphaned" : "Stale"}
      </div>
    </div>
  );
}
