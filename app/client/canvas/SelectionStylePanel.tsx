import {
  BriefcaseBusiness,
  CircleMinus,
  Code2,
  Columns3,
  Diff,
  Layers,
  LayoutDashboard,
  Loader2,
  Merge,
  Scan,
} from "lucide-react";
import {
  createShapeId,
  DefaultStylePanel,
  DefaultStylePanelContent,
  TldrawUiButton,
  type Editor,
  type TLShapeId,
  type TLUiStylePanelProps,
  useEditor,
  useActions,
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
import { getSelectedQueryIds, isBizMode, setQueriesBizMode } from "./bizMode";
import { getLayoutActionAvailability, getLayoutInProgress } from "./layoutActions";
import { getLayoutSelection, isLayoutNode } from "./layoutSelection";
import { SelectionOperationDialog } from "./SelectionOperationDialog";

const operations = [
  {
    operation: "UNION ALL",
    icon: Layers,
    color: "#ef4444",
    description: "Stack all rows, keeping duplicates. Columns match by position.",
  },
  {
    operation: "UNION",
    icon: Merge,
    color: "#b91c1c",
    description: "Combine rows and remove duplicates. Columns match by position.",
  },
  { operation: "JOIN", icon: Columns3, color: "#2563eb", description: "Join matching rows using keys you choose." },
  {
    operation: "INTERSECT",
    icon: Scan,
    color: "#15803d",
    description: "Keep distinct rows present in every input. Columns match by position.",
  },
  {
    operation: "EXCEPT",
    icon: CircleMinus,
    color: "#c2410c",
    description: "Keep rows in A that are absent from the other inputs. Choose A before running.",
  },
  {
    operation: "DIFF",
    icon: Diff,
    color: "#0e7490",
    description: "Compare two datasets to find added, removed, or changed records.",
  },
] satisfies { operation: SelectionOperation; icon: typeof Merge; color: string; description: string }[];

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
  const actions = useActions();
  const selection = useValue(
    "selection controls",
    () => {
      const queryIds = editor.isIn("select") ? getSelectedQueryIds(editor) : [];
      return {
        ...getLayoutActionAvailability(editor),
        hasNodes: editor.isIn("select") && getLayoutSelection(editor).some(isLayoutNode),
        layingOut: getLayoutInProgress(editor).get(),
        queryIds,
        allBiz: queryIds.length > 0 && queryIds.every((id) => isBizMode(editor, id)),
        allSQL: queryIds.length > 0 && queryIds.every((id) => !isBizMode(editor, id)),
      };
    },
    [editor]
  );
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
      {selection.hasNodes && (
        <div
          className="tlui-style-panel__section"
          role="group"
          aria-label="Selected nodes"
          style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", padding: 4 }}
        >
          <TldrawUiButton
            type="icon"
            data-testid="selection.layout"
            aria-label="Auto layout selected nodes"
            aria-keyshortcuts="Shift+A"
            aria-busy={selection.layingOut}
            title="Auto layout selected nodes (Shift+A)"
            disabled={!selection.canLayout}
            style={{ width: "100%", minWidth: 0, height: 32, padding: 4, gap: 4, fontSize: 11 }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={() => void actions["layout-kavla-nodes"].onSelect("style-panel")}
          >
            {selection.layingOut ? (
              <Loader2 size={16} className="animate-spin" aria-hidden />
            ) : (
              <LayoutDashboard size={16} aria-hidden />
            )}
            <span className="kavla-control-label">Layout</span>
          </TldrawUiButton>
          <TldrawUiButton
            type="icon"
            data-testid="selection.fit"
            aria-label="Fit selected query nodes to their content"
            aria-keyshortcuts="Shift+F"
            title="Fit selected query nodes to their content (Shift+F)"
            disabled={!selection.canFit}
            style={{ width: "100%", minWidth: 0, height: 32, padding: 4, gap: 4, fontSize: 11 }}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={() => void actions["fit-query-nodes"].onSelect("style-panel")}
          >
            <Scan size={16} aria-hidden />
            <span className="kavla-control-label">Fit</span>
          </TldrawUiButton>
        </div>
      )}
      {selection.queryIds.length > 0 && (
        <div
          className="tlui-style-panel__section"
          role="group"
          aria-label="Selected query mode"
          style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", padding: 4 }}
        >
          {(["SQL", "Biz"] as const).map((mode) => {
            const isBiz = mode === "Biz";
            const active = isBiz ? selection.allBiz : selection.allSQL;
            const Icon = isBiz ? BriefcaseBusiness : Code2;
            return (
              <TldrawUiButton
                key={mode}
                type="icon"
                data-testid={`selection.mode-${mode.toLowerCase()}`}
                aria-label={`Show ${mode} mode for selected queries`}
                aria-pressed={active}
                isActive={active}
                title={`Show ${isBiz ? "query flows" : "SQL"} for selected queries (Shift+B to toggle)`}
                style={{ width: "100%", minWidth: 0, height: 32, padding: 4, gap: 4, fontSize: 11 }}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={() => setQueriesBizMode(editor, getSelectedQueryIds(editor), isBiz)}
              >
                <Icon size={16} aria-hidden />
                <span className="kavla-control-label">{mode}</span>
              </TldrawUiButton>
            );
          })}
        </div>
      )}
      {inputs.length >= 2 && (
        <div
          className="tlui-style-panel__section"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            padding: 4,
            backgroundColor: "#fff",
            borderRadius: 8,
          }}
        >
          {operations.map(({ operation, icon: Icon, color, description }) => {
            const error =
              operation === "DIFF"
                ? inputs.length !== 2
                  ? "Select exactly two datasets to compare."
                  : getKeyOperationError(inputs)
                : operation === "JOIN"
                  ? getKeyOperationError(inputs)
                  : getSetOperationError(inputs);
            return (
              <TldrawUiButton
                key={operation}
                type="icon"
                data-testid={`selection.${operation.toLowerCase().replaceAll(" ", "-")}`}
                aria-label={`${operation} selected data`}
                title={`${operation}: ${error || description}`}
                disabled={Boolean(error)}
                style={{ width: "100%", minWidth: 0, height: 32, color, opacity: error ? 0.4 : 1 }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => selectOperation(operation)}
              >
                <Icon size={18} aria-hidden="true" />
              </TldrawUiButton>
            );
          })}
        </div>
      )}
    </DefaultStylePanel>
  );
}
