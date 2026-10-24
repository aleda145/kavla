import { Merge } from "lucide-react";
import {
  createShapeId,
  DefaultStylePanel,
  DefaultStylePanelContent,
  type Editor,
  type TLShapeId,
  type TLUiStylePanelProps,
  useEditor,
  useRelevantStyles,
  useToasts,
  useValue,
} from "tldraw";
import { executeSQLShape } from "../../SQLTextArea/executeSQLShape";
import type { SQLDependencyShape } from "../../SQLTextArea/sqlDependencies";
import { getAutoExpandedSQLShapeSize } from "../../SQLTextArea/sqlShapeSize";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { quoteIdentifier } from "../../src/duckdb/sql";
import { getUniqueName } from "../../util/getUniqueName";
import { connectShapes } from "../../util/shapeConnections";
import { useData } from "../useLocalServer";

function getSelectedUnionInputs(editor: Editor): SQLDependencyShape[] {
  const inputs = new Map<TLShapeId, SQLDependencyShape>();
  for (const selected of editor.getSelectedShapes()) {
    let shape = selected;
    if (
      (shape.type === "sql-result-table" || shape.type === "chart-shape") &&
      "sourceShapeId" in shape.props &&
      typeof shape.props.sourceShapeId === "string"
    ) {
      const source = editor.getShape(shape.props.sourceShapeId as TLShapeId);
      if (!source) continue;
      shape = source;
    }
    if (shape.type === "data-source" || shape.type === "sql-text-area") {
      inputs.set(shape.id, shape as SQLDependencyShape);
    }
  }
  return Array.from(inputs.values());
}

export function SelectionStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const data = useData();
  const styles = useRelevantStyles();
  const { addToast } = useToasts();
  const canUnion = useValue(
    "can union selection",
    () => !editor.getIsReadonly() && editor.isIn("select") && getSelectedUnionInputs(editor).length >= 2,
    [editor]
  );

  const unionSelection = async () => {
    if (editor.getIsReadonly()) return;
    const inputs = getSelectedUnionInputs(editor);
    const bounds = editor.getSelectionPageBounds();
    if (inputs.length < 2 || !bounds) return;

    const id = createShapeId();
    const sql = inputs.map((shape) => `SELECT * FROM ${quoteIdentifier(shape.props.name)}`).join("\nUNION ALL\n");

    try {
      editor.markHistoryStoppingPoint("union selection");
      editor.run(() => {
        editor.createShape<SQLTextAreaShape>({
          id,
          type: "sql-text-area",
          parentId: editor.getCurrentPageId(),
          x: bounds.maxX + 60,
          y: bounds.minY,
          props: {
            ...getAutoExpandedSQLShapeSize(sql),
            name: getUniqueName(editor, "union_query"),
            text: sql,
            showTable: true,
            isDirty: true,
          },
        });
        for (const input of inputs) connectShapes(editor, input.id, id);
        editor.select(id);
      });
      editor.zoomToSelection({ animation: { duration: 250 } });
      const result = await executeSQLShape(editor, data, id, sql, new AbortController().signal);
      if (!result.success) throw new Error(result.error || "The union query failed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (editor.getShape(id)) {
        editor.updateShape<SQLTextAreaShape>({
          id,
          type: "sql-text-area",
          props: { error: message, isDirty: true },
        });
      }
      addToast({ title: "Union failed", description: message, severity: "error" });
    }
  };

  return (
    <DefaultStylePanel {...props}>
      <DefaultStylePanelContent styles={styles} />
      {canUnion && (
        <div className="tlui-style-panel__section">
          <button
            type="button"
            data-testid="selection.union-all"
            aria-label="Union all selected data"
            title="Create and run a UNION ALL query. Keeps duplicates; columns are matched by position."
            className="h-9 w-full px-3 border-2 border-black bg-yellow-100 hover:bg-yellow-200 text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px]"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void unionSelection()}
          >
            <Merge size={16} />
            <span className="kavla-control-label">Union all</span>
          </button>
        </div>
      )}
    </DefaultStylePanel>
  );
}
