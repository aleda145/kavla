import { BriefcaseBusiness, Code2, LayoutDashboard, Loader2, Scan } from "lucide-react";
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
    label: "Union all",
    description: "Stack all rows, keeping duplicates. Columns match by position.",
  },
  {
    operation: "UNION",
    label: "Union",
    description: "Combine rows and remove duplicates. Columns match by position.",
  },
  { operation: "JOIN", label: "Join", description: "Join matching rows using keys you choose." },
  {
    operation: "INTERSECT",
    label: "Intersect",
    description: "Keep distinct rows present in every input. Columns match by position.",
  },
  {
    operation: "EXCEPT",
    label: "Except",
    description: "Keep rows in A that are absent from the other inputs. Choose A before running.",
  },
  {
    operation: "DIFF",
    label: "Diff",
    description: "Compare two datasets to find added, removed, or changed records.",
  },
] satisfies { operation: SelectionOperation; label: string; description: string }[];

function SelectionOperationIcon({ operation }: { operation: SelectionOperation }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
      focusable="false"
    >
      {operation === "UNION ALL" ? (
        <>
          <rect x={3} y={2} width={14} height={5} rx={1} fill="currentColor" fillOpacity={0.2} />
          <rect x={3} y={10} width={14} height={5} rx={1} fill="currentColor" fillOpacity={0.2} />
          <path d="M3 18v3h10M19 16v6m-3-3h6" />
        </>
      ) : operation === "JOIN" ? (
        <>
          <rect x={1} y={4} width={8} height={16} rx={1.5} />
          <rect x={15} y={4} width={8} height={16} rx={1.5} />
          <path d="M1 9h8m6 0h8M1 14h8m6 0h8" />
          <path d="M6 12h12" strokeWidth={3} />
          <circle cx={6} cy={12} r={1.5} fill="currentColor" stroke="none" />
          <circle cx={18} cy={12} r={1.5} fill="currentColor" stroke="none" />
        </>
      ) : operation === "DIFF" ? (
        <>
          <rect x={2} y={3} width={20} height={18} rx={2} />
          <path d="M2 12h20M5 7.5h4m-2-2v4M5 16.5h4M13 7.5h6m-6 9h6" />
        </>
      ) : (
        <>
          {/* Highlight the result region while keeping both input sets visible. */}
          <path
            d={
              operation === "INTERSECT"
                ? "M12 6.255a7 7 0 0 1 0 11.49a7 7 0 0 1 0-11.49Z"
                : operation === "EXCEPT"
                  ? "M12 6.255a7 7 0 1 0 0 11.49a7 7 0 0 1 0-11.49Z"
                  : "M12 6.255a7 7 0 1 0 0 11.49a7 7 0 1 0 0-11.49Z"
            }
            fill="currentColor"
            fillOpacity={0.2}
            stroke="none"
          />
          <circle cx={8} cy={12} r={7} />
          <circle cx={16} cy={12} r={7} />
        </>
      )}
    </svg>
  );
}

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
          className="tlui-style-panel__section kavla-selection-operations"
          role="group"
          aria-label="Combine selected datasets"
        >
          {operations.map(({ operation, label, description }) => {
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
                className="kavla-selection-operation"
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={() => selectOperation(operation)}
              >
                <SelectionOperationIcon operation={operation} />
                <span className="kavla-control-label">{label}</span>
              </TldrawUiButton>
            );
          })}
        </div>
      )}
    </DefaultStylePanel>
  );
}
