import { CircleMinus, Columns3, Diff, Layers, Merge, Scan } from "lucide-react";
import {
  createShapeId,
  DefaultStylePanel,
  DefaultStylePanelContent,
  type Editor,
  type TLShapeId,
  type TLUiStylePanelProps,
  useEditor,
  useDialogs,
  useRelevantStyles,
  useToasts,
  useValue,
} from "tldraw";
import { executeSQLShape } from "../../SQLTextArea/executeSQLShape";
import type { SQLDependencyShape } from "../../SQLTextArea/sqlDependencies";
import { getAutoExpandedSQLShapeSize } from "../../SQLTextArea/sqlShapeSize";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import {
  buildSelectionQuery,
  getKeyOperationError,
  getSetOperationError,
  type KeyMapping,
  type SelectionOperation,
} from "../../SQLTextArea/selectionOperations";
import { getUniqueName } from "../../util/getUniqueName";
import { connectShapes } from "../../util/shapeConnections";
import { useData } from "../useLocalServer";
import { SelectionOperationDialog } from "./SelectionOperationDialog";

const operations = [
  {
    operation: "UNION ALL",
    icon: Layers,
    description: "Stack all rows, keeping duplicates. Columns match by position.",
  },
  { operation: "UNION", icon: Merge, description: "Combine rows and remove duplicates. Columns match by position." },
  { operation: "JOIN", icon: Columns3, description: "Join matching rows using keys you choose." },
  {
    operation: "INTERSECT",
    icon: Scan,
    description: "Keep distinct rows present in every input. Columns match by position.",
  },
  {
    operation: "EXCEPT",
    icon: CircleMinus,
    description: "Keep rows in A that are absent from the other inputs. Choose A before running.",
  },
  { operation: "DIFF", icon: Diff, description: "Compare two datasets to find added, removed, or changed records." },
] satisfies { operation: SelectionOperation; icon: typeof Merge; description: string }[];

function getSelectedInputs(editor: Editor): SQLDependencyShape[] {
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
  return Array.from(inputs.values()).sort((a, b) => {
    const aBounds = editor.getShapePageBounds(a);
    const bBounds = editor.getShapePageBounds(b);
    return (
      (aBounds?.x ?? a.x) - (bBounds?.x ?? b.x) || (aBounds?.y ?? a.y) - (bBounds?.y ?? b.y) || a.id.localeCompare(b.id)
    );
  });
}

export function SelectionStylePanel(props: TLUiStylePanelProps) {
  const editor = useEditor();
  const data = useData();
  const styles = useRelevantStyles();
  const { addToast } = useToasts();
  const { addDialog } = useDialogs();
  const inputs = useValue(
    "selection operation inputs",
    () => (!editor.getIsReadonly() && editor.isIn("select") ? getSelectedInputs(editor) : []),
    [editor]
  );

  const runOperation = async (operation: SelectionOperation, inputIds: TLShapeId[], keys: KeyMapping[] = []) => {
    if (editor.getIsReadonly()) return;
    const bounds = editor.getSelectionPageBounds();
    if (!bounds) return;

    const id = createShapeId();
    try {
      const currentInputs = inputIds.map((inputId) => {
        const input = editor.getShape(inputId);
        if (
          !input ||
          !editor.getCurrentPageShapeIds().has(inputId) ||
          (input.type !== "data-source" && input.type !== "sql-text-area")
        ) {
          throw new Error("A selected dataset is no longer available on this page.");
        }
        return input as SQLDependencyShape;
      });
      const { sql } = buildSelectionQuery(operation, currentInputs, keys);
      const name = getUniqueName(editor, `${operation.toLowerCase().replaceAll(" ", "_")}_query`);
      editor.markHistoryStoppingPoint(`${operation.toLowerCase()} selection`);
      editor.run(() => {
        editor.createShape<SQLTextAreaShape>({
          id,
          type: "sql-text-area",
          parentId: editor.getCurrentPageId(),
          x: bounds.maxX + 60,
          y: bounds.minY,
          props: {
            ...getAutoExpandedSQLShapeSize(sql),
            name,
            text: sql,
            showTable: true,
            isDirty: true,
          },
        });
        for (const input of currentInputs) connectShapes(editor, input.id, id);
        editor.select(id);
      });
      editor.zoomToSelection({ animation: { duration: 250 } });
      const result = await executeSQLShape(editor, data, id, sql, new AbortController().signal);
      if (!result.success) throw new Error(result.error || `The ${operation} query failed.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (editor.getShape(id)) {
        editor.updateShape<SQLTextAreaShape>({
          id,
          type: "sql-text-area",
          props: { error: message, isDirty: true, isRunning: false, queryStartTime: null, runnerName: null },
        });
      }
      addToast({ title: `${operation} failed`, description: message, severity: "error" });
    }
  };

  const selectOperation = (operation: SelectionOperation) => {
    const selectedInputs = getSelectedInputs(editor);
    if (selectedInputs.length < 2) return;
    if (operation === "JOIN" || operation === "EXCEPT" || operation === "DIFF") {
      addDialog({
        component: (dialogProps) => (
          <SelectionOperationDialog
            {...dialogProps}
            operation={operation}
            inputs={selectedInputs}
            onRun={(ids, keys) => void runOperation(operation, ids, keys)}
          />
        ),
      });
    } else {
      void runOperation(
        operation,
        selectedInputs.map((input) => input.id)
      );
    }
  };

  return (
    <DefaultStylePanel {...props}>
      <DefaultStylePanelContent styles={styles} />
      {inputs.length >= 2 && (
        <div className="tlui-style-panel__section" style={{ display: "grid", gap: 6 }}>
          {operations.map(({ operation, icon: Icon, description }) => {
            const error =
              operation === "DIFF"
                ? inputs.length !== 2
                  ? "Select exactly two datasets to compare."
                  : getKeyOperationError(inputs)
                : operation === "JOIN"
                  ? getKeyOperationError(inputs)
                  : getSetOperationError(inputs);
            return (
              <button
                key={operation}
                type="button"
                data-testid={`selection.${operation.toLowerCase().replaceAll(" ", "-")}`}
                aria-label={`${operation} selected data`}
                title={error || description}
                disabled={Boolean(error)}
                className="h-9 w-full px-3 border-2 border-black bg-yellow-100 hover:bg-yellow-200 text-black font-bold text-xs flex items-center justify-center gap-2 rounded cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px] disabled:opacity-40 disabled:cursor-not-allowed"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => selectOperation(operation)}
              >
                <Icon size={16} />
                <span className="kavla-control-label">{operation}</span>
              </button>
            );
          })}
        </div>
      )}
    </DefaultStylePanel>
  );
}
