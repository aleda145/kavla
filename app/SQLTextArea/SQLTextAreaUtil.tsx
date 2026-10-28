import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLResizeInfo,
  resizeBox,
  TLShapeId,
  createShapeId,
  useToasts,
} from "tldraw";
import { SQLTextAreaMigrations } from "./sql-text-area-migrations";
import { SQLTextAreaProps } from "./sql-text-area-props";
import { SQLTextAreaShape } from "./sql-text-area-types";
import { connectShapes, disconnectShapes } from "../util/shapeConnections";

import { getUniqueName } from "../util/getUniqueName";
import { useData } from "../client/useLocalServer";
import { useEffect, useRef, useState } from "react";
import { validateBackendQuery } from "../client/backendCompute";
import { ShapeEngineTabs } from "../util/ShapeEngineTabs";
import { type EditorValidationIssue, issueFromUnknownError, validateDuckDBSyntax } from "./editor-validation";
import { format } from "sql-formatter";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";
import { RUN_SQL_SHAPE_REQUEST_EVENT, dispatchSQLShapeRunFinished, type RunSQLShapeRequestDetail } from "./sqlShapeRun";
import { SQLTextAreaBody } from "./SQLTextAreaBody";
import { SQLTextAreaFooter } from "./SQLTextAreaFooter";
import { SQLTextAreaHeader } from "./SQLTextAreaHeader";
import { describeQueryExecution } from "./walkSQLDag";
import { prepareCanvasSQL } from "./prepareCanvasSQL";
import { executeSQLShape } from "./executeSQLShape";
import { hasDbtTemplate } from "../Dbt/dbtSQL";
import { useDbtTab } from "../Dbt/useDbtTab";
import { getAutoExpandedSQLShapeSize } from "./sqlShapeSize";
import { getKnobNames, getSQLKnobs, resolveKnobSQL } from "../Knob/knobSQL";
import { useBizMode } from "../client/canvas/bizMode";

export class SQLTextAreaUtil extends ShapeUtil<SQLTextAreaShape> {
  private updateSourceName: ((payload: { prevName: string; nextName: string }) => void) | null = null;
  static override type = "sql-text-area" as const;
  static override props = SQLTextAreaProps;
  static override migrations = SQLTextAreaMigrations;

  getDefaultProps(): SQLTextAreaShape["props"] {
    return {
      w: 400,
      h: 300,
      text: "SELECT 1",
      linkedTableId: null,
      error: null,
      isRunning: false,
      query: null,
      name: getUniqueName(this.editor, "query"),
      downstreamShapeIds: null,
      upstreamShapeIds: null,
      stale: false,
      isDirty: false,
      queryStartTime: null,
      showTable: true, // Default to showing the table
      runnerName: null,
      lastRunStats: null,
      outputSchema: null,
      columnStats: null,
      isManuallyResized: false,
    };
  }

  getGeometry(shape: SQLTextAreaShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override onBeforeCreate(next: SQLTextAreaShape): SQLTextAreaShape | void {
    if (next.props.isManuallyResized) return;
    const size = getAutoExpandedSQLShapeSize(next.props.text, next.props);
    if (size.w === next.props.w && size.h === next.props.h) return;
    return { ...next, props: { ...next.props, ...size } };
  }

  override onBeforeUpdate(prev: SQLTextAreaShape, next: SQLTextAreaShape): SQLTextAreaShape | void {
    const prevName = prev.props.name;
    const nextName = next.props.name;

    if (prevName !== nextName) {
      if (this.updateSourceName) {
        this.updateSourceName({ prevName, nextName });
      } else {
        console.error("updateSourceName function not initialized");
      }
    }

    if (prev.props.text === next.props.text || next.props.isManuallyResized) return;
    const size = getAutoExpandedSQLShapeSize(next.props.text, next.props);
    if (size.w === next.props.w && size.h === next.props.h) return;
    return { ...next, props: { ...next.props, ...size } };
  }

  component(shape: SQLTextAreaShape) {
    const bizMode = useBizMode(this.editor, shape.id);
    const { addToast } = useToasts();
    const data = useData();
    const dbtTab = useDbtTab(shape);
    const { updateSourceName, cancelRemoteQuery } = data;
    const runController = useRef<AbortController | null>(null);
    this.updateSourceName = updateSourceName;
    const [isRemoteRunning, setIsRemoteRunning] = useState(false);

    const ensureResultTable = async () => {
      const currentShape = this.editor.getShape<SQLTextAreaShape>(shape.id);
      if (!currentShape) return;

      const tableId = currentShape.props.linkedTableId as TLShapeId;

      if (tableId) {
        const existing = this.editor.getShape(tableId);
        if (existing?.type === "sql-result-table") {
          return; // Already exists, we are good
        }
      }

      const newShapeId = createShapeId();
      this.editor.createShape({
        type: "sql-result-table",
        id: newShapeId,
        x: currentShape.x,
        y: currentShape.y + this.editor.getShapeGeometry(currentShape).bounds.height + 60,
        props: {
          sourceShapeId: currentShape.id,
          w: 400,
          h: 300,
        },
      });

      update({
        linkedTableId: newShapeId,
      });

      connectShapes(this.editor, currentShape.id, newShapeId);
    };

    const handleToggleTable = async () => {
      const nextState = !shape.props.showTable;

      update({ showTable: nextState });

      if (nextState) {
        if (shape.props.isDirty || shape.props.stale || !shape.props.lastRunStats) {
          await handleRun();
        } else {
          await ensureResultTable();
        }
      } else {
        const tableId = shape.props.linkedTableId;
        if (tableId) {
          disconnectShapes(this.editor, shape.id, tableId as TLShapeId);
          this.editor.deleteShape(tableId as TLShapeId);
          update({ linkedTableId: null });
        }
      }
    };

    useEffect(() => {
      if (!shape.props.isRunning) {
        setIsRemoteRunning(false);
      }
    }, [shape.props.isRunning]);

    const update = (newProps: Partial<SQLTextAreaShape["props"]>) => {
      this.editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: newProps,
      });
    };

    const { text } = shape.props;
    const getOrderedDependencies = (currentText: string) => getOrderedDependenciesForSQL(this.editor, currentText);
    const { orderedDependencies: currentDependencies } = getOrderedDependencies(text);
    const queryExecutionState = describeQueryExecution(currentDependencies);

    const handleValidate = async (sql: string): Promise<EditorValidationIssue | null> => {
      if (!sql.trim()) return null;
      const knobs = getSQLKnobs(this.editor, sql);
      // Let debounced creation and column inference finish before validating parameters.
      if (
        getKnobNames(sql).some((name) => !knobs.some((knob) => knob.props.name.toUpperCase() === name)) ||
        knobs.some((knob) => knob.props.inferenceStatus === "loading")
      )
        return null;

      try {
        if (!hasDbtTemplate(sql)) {
          const syntaxIssue = validateDuckDBSyntax(resolveKnobSQL(this.editor, sql));
          if (syntaxIssue) return syntaxIssue;
        }
        const prepared = await prepareCanvasSQL(this.editor, sql);
        if (prepared.executionState.sourceNativePreview && prepared.executionState.sourceType !== "duckdb") return null;
        await validateBackendQuery(prepared.sql);
        return null;
      } catch (e: unknown) {
        console.error("Validation error", e);
        return issueFromUnknownError(e);
      }
    };

    const handleRun = async (options?: { sqlText?: string; formatBeforeRun?: boolean }) => {
      const sql =
        typeof options?.sqlText === "string"
          ? options.sqlText
          : (this.editor.getShape<SQLTextAreaShape>(shape.id)?.props.text ?? text);
      if (runController.current || this.editor.getShape<SQLTextAreaShape>(shape.id)?.props.isRunning)
        return { success: false, error: "Query is already running." };
      const controller = new AbortController();
      runController.current = controller;
      setIsRemoteRunning(true);
      try {
        return await executeSQLShape(this.editor, data, shape.id, sql, controller.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        update({ error: message, isDirty: true });
        dispatchSQLShapeRunFinished(shape.id, { success: false, error: message });
        return { success: false, error: message };
      } finally {
        runController.current = null;
        setIsRemoteRunning(false);
      }
    };

    const handleCancel = () => {
      if (!this.editor.getShape<SQLTextAreaShape>(shape.id)?.props.isRunning) return;
      runController.current?.abort();
      cancelRemoteQuery(shape.id, shape.props.name);
    };

    const handleChainQuery = () => {
      const newShapeId = createShapeId();

      this.editor.createShape({
        type: "sql-text-area",
        id: newShapeId,
        x: shape.x + this.editor.getShapeGeometry(shape).bounds.width + 60,
        y: shape.y,
        props: {
          text: `SELECT\n  *\nFROM\n  ${shape.props.name}`,
        },
      });
      connectShapes(this.editor, shape.id, newShapeId);

      setTimeout(() => {
        this.editor.select(newShapeId);
        this.editor.zoomToSelection({ animation: { duration: 250 } });
      }, 50);
    };

    const handleCreateChart = async () => {
      if (shape.props.isDirty || shape.props.stale || !shape.props.lastRunStats) {
        const result = await handleRun();
        if (!result.success) return;
      }
      const newShapeId = createShapeId();
      this.editor.createShape({
        type: "chart-shape",
        id: newShapeId,
        x: shape.x,
        y: shape.y - 460,
        props: {
          sourceShapeId: shape.id,
          chartType: "scatter",
          x: null,
          y: null,
          color: null,
          yAxisScale: "default",
          isStacked: false,
          limit: null,
          w: 600,
          h: 400,
          name: "chart",
        },
      });
      connectShapes(this.editor, shape.id, newShapeId);
    };

    const handleFormat = (overrideText?: string) => {
      if (shape.props.dbt || hasDbtTemplate(overrideText ?? shape.props.text)) {
        return overrideText ?? shape.props.text;
      }
      try {
        let formattedSql = "";
        if (typeof overrideText === "string") {
          formattedSql = overrideText;
        } else {
          const messySql = shape.props.text;
          formattedSql = format(messySql, {
            language: "duckdb", // Always specify a dialect for best results
            paramTypes: { custom: [{ regex: "\\{[A-Za-z_][A-Za-z0-9_]*\\}" }] },
            keywordCase: "upper", // Forces "SELECT", "FROM"
            tabWidth: 2, // Indentation size
          });
        }
        update({ text: formattedSql });
        return formattedSql;
      } catch (e) {
        console.error("Formatting failed", e);
        addToast({ title: "Formatting Failed", description: "Could not format SQL.", severity: "error" });
        return null;
      }
    };

    useEffect(() => {
      const handleProgrammaticRun = (event: Event) => {
        const customEvent = event as CustomEvent<RunSQLShapeRequestDetail>;
        if (customEvent.detail.shapeId !== shape.id) {
          return;
        }

        if (shape.props.isRunning) {
          customEvent.detail.resolve({
            success: false,
            error: "Query is already running.",
          });
          return;
        }

        void handleRun({
          sqlText: customEvent.detail.sqlText ?? shape.props.text,
          formatBeforeRun: true,
        }).then((result) => {
          customEvent.detail.resolve(result);
        });
      };

      window.addEventListener(RUN_SQL_SHAPE_REQUEST_EVENT, handleProgrammaticRun as EventListener);
      return () => {
        window.removeEventListener(RUN_SQL_SHAPE_REQUEST_EVENT, handleProgrammaticRun as EventListener);
      };
    }, [handleRun, shape.id, shape.props.isRunning, shape.props.text]);

    const hasFooter = Boolean(
      (shape.props.isRunning && shape.props.queryStartTime) || shape.props.error || shape.props.lastRunStats
    );

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          display: "flex",
          flexDirection: "column",
          pointerEvents: "all",
          position: "relative",
          padding: 0,
          width: shape.props.w,
          height: shape.props.h,
          boxSizing: "border-box",
          overflow: "visible", // Allow tooltips to spill out
          fontFamily: "Inter, sans-serif",
        }}
      >
        <ShapeEngineTabs
          tabs={dbtTab ? [...queryExecutionState.tabs, dbtTab] : queryExecutionState.tabs}
          style={{ position: "absolute", top: -46, left: 0, right: 0 }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            borderRadius: 12,
            backgroundColor: "#fff",
            boxSizing: "border-box",
            overflow: "hidden",
            padding: 4,
            position: "relative",
            zIndex: 1,
          }}
        >
          <SQLTextAreaHeader
            editor={this.editor}
            shape={shape}
            onNameChange={(name) =>
              this.editor.updateShape({
                id: shape.id,
                type: shape.type,
                props: { name },
              })
            }
          />

          <SQLTextAreaBody
            bizMode={bizMode}
            hasFooter={hasFooter}
            isRemoteRunning={isRemoteRunning || shape.props.isRunning}
            shape={shape}
            text={text}
            onCancel={handleCancel}
            onChainQuery={handleChainQuery}
            onCreateChart={handleCreateChart}
            onFormat={handleFormat}
            onRun={handleRun}
            onTextChange={(value) => update({ text: value, isDirty: true })}
            onToggleTable={handleToggleTable}
            validator={handleValidate}
          />
          <SQLTextAreaFooter shape={shape} />
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: "4px solid #000",
              borderRadius: 12,
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        </div>
      </HTMLContainer>
    );
  }

  indicator(shape: SQLTextAreaShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }

  override onResize(shape: SQLTextAreaShape, info: TLResizeInfo<SQLTextAreaShape>) {
    const resized = resizeBox(shape, info);
    return {
      ...resized,
      props: {
        ...resized.props,
        isManuallyResized: true,
      },
    };
  }
}
