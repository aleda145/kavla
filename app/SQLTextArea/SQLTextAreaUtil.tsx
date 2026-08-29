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
import { connectShapes, disconnectShapes, setShapeUpstreamConnections } from "../util/shapeConnections";

import { getUniqueName } from "../util/getUniqueName";
import { useData } from "../client/useLocalServer";
import { useEffect, useState } from "react";
import { DuckDBService } from "@/duckdb-service";
import { ShapeEngineTabs } from "../util/ShapeEngineTabs";
import {
  type EditorValidationIssue,
  issueFromMessage,
  issueFromUnknownError,
  validateDuckDBSyntax,
} from "./editor-validation";
import { format } from "sql-formatter";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";
import {
  RUN_SQL_SHAPE_REQUEST_EVENT,
  dispatchSQLShapeRunFinished,
  dispatchSQLShapeRunStarted,
  type RunSQLShapeRequestDetail,
} from "./sqlShapeRun";
import { SQLTextAreaBody } from "./SQLTextAreaBody";
import { SQLTextAreaFooter } from "./SQLTextAreaFooter";
import { SQLTextAreaHeader } from "./SQLTextAreaHeader";
import { loadSQLDagDependencies } from "./sqlDagDependencies";
import { clearRestoredRemoteQueryMetadata } from "./restoreRemoteQueryView";
import {
  buildRemoteSQLFromDag,
  describeQueryExecution,
  getMountedFileSourcesForRemoteExecution,
  walkSQLDag,
} from "./walkSQLDag";

export class SQLTextAreaUtil extends ShapeUtil<SQLTextAreaShape> {
  private updateSourceName: ((payload: { prevName: string; nextName: string }) => void) | null = null;
  static override type = "sql-text-area" as const;
  static override props = SQLTextAreaProps;
  static override migrations = SQLTextAreaMigrations;

  override isAspectRatioLocked(_shape: SQLTextAreaShape) {
    return false;
  }
  override canResize(_shape: SQLTextAreaShape) {
    return true;
  }

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

  override onBeforeUpdate(prev: SQLTextAreaShape, next: SQLTextAreaShape): void {
    const prevName = prev.props.name;
    const nextName = next.props.name;

    if (prevName === nextName) {
      return;
    }

    if (this.updateSourceName) {
      this.updateSourceName({ prevName, nextName });
    } else {
      console.error("updateSourceName function not initialized");
    }
  }

  component(shape: SQLTextAreaShape) {
    const { addToast } = useToasts();
    const { updateSourceName, runRemoteQuery, cancelRemoteQuery } = useData();
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
        y: currentShape.y + currentShape.props.h + 60,
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
        if (shape.props.isDirty) {
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

      try {
        const syntaxIssue = validateDuckDBSyntax(sql);
        if (syntaxIssue) {
          return syntaxIssue;
        }

        const { orderedDependencies } = getOrderedDependencies(sql);
        const validationExecutionState = describeQueryExecution(orderedDependencies);

        if (validationExecutionState.isRemoteExecution) {
          const remoteFileSourcePlan = getMountedFileSourcesForRemoteExecution(orderedDependencies);
          return remoteFileSourcePlan.validationMessage
            ? issueFromMessage(remoteFileSourcePlan.validationMessage)
            : null;
        }

        await loadSQLDagDependencies(orderedDependencies, { mode: "validation" });

        const duckDBService = DuckDBService.getInstance();
        const executionError = await duckDBService.validateQuery(sql);
        if (!executionError) {
          return null;
        }

        return issueFromMessage(executionError);
      } catch (e: unknown) {
        console.error("Validation error", e);
        return issueFromUnknownError(e);
      }
    };

    const runQueryLogic = async (sqlText: string, markRunning: boolean = true) => {
      const startTime = Date.now();
      clearRestoredRemoteQueryMetadata(shape.id);

      const dagWalk = walkSQLDag(this.editor, sqlText);
      if (!dagWalk.ok) {
        addToast({
          title: dagWalk.error.title,
          description: dagWalk.error.message,
          severity: "error",
        });
        return { success: false, error: dagWalk.error.message };
      }
      const {
        executionState: currentQueryExecutionState,
        mountedFileSources,
        nextUpstreamShapeIds,
        orderedDependencies,
      } = dagWalk.plan;
      const runnerName = currentQueryExecutionState.isRemoteExecution ? "CLI" : "Local";
      setShapeUpstreamConnections(
        this.editor,
        shape.id,
        nextUpstreamShapeIds.map((shapeId) => shapeId as TLShapeId)
      );

      if (markRunning) {
        update({
          isRunning: true,
          error: null,
          isDirty: false,
          queryStartTime: startTime,
          runnerName,
        });
      }

      try {
        const duckDBService = DuckDBService.getInstance();
        const isRemoteExecution = currentQueryExecutionState.isRemoteExecution;
        await loadSQLDagDependencies(orderedDependencies, {
          mode: "execution",
          isRemoteExecution: currentQueryExecutionState.isRemoteExecution,
        });

        let rowCount: number;
        let schema: { name: string; type: string }[];
        let sampleRows: Record<string, unknown>[] = [];
        setIsRemoteRunning(isRemoteExecution);

        if (isRemoteExecution) {
          const { sourceName, sourceType, sourceNativePreview } = currentQueryExecutionState;
          const finalSQL = buildRemoteSQLFromDag(sqlText, orderedDependencies);

          const result = await runRemoteQuery({
            sql: finalSQL,
            sourceName: sourceName,
            sourceType,
            shapeId: shape.id,
            queryName: shape.props.name,
            sourceNative: sourceNativePreview,
            mountedFileSources,
          });
          rowCount = result.rowCount;
          schema = result.schema;
          sampleRows = result.sampleRows;
        } else {
          const res = await duckDBService.runQueryView(sqlText, shape.props.name);
          rowCount = res.rowCount;
          schema = res.schema;
          sampleRows = res.sampleRows;
        }

        const executionTime = Date.now() - startTime;
        update({
          isRunning: false,
          queryStartTime: null,
          runnerName: null,
          outputSchema: schema,
          columnStats: null,
          lastRunStats: {
            executionTime,
            rowCount,
            runnerName,
          },
        });
        const latestShape = this.editor.getShape<SQLTextAreaShape>(shape.id);
        if (latestShape?.props.showTable) {
          await ensureResultTable();
        }

        return { success: true, rowCount, outputSchema: schema, sampleRows };
      } catch (e: any) {
        console.error(e);
        if (e?.name === "AbortError" || e?.message === "Query cancelled") {
          update({ isRunning: false, error: null, queryStartTime: null, runnerName: null });
          return { success: false, error: "Query cancelled" };
        } else {
          const errorMessage = e.message ?? "Unknown error";
          update({ isRunning: false, error: errorMessage, queryStartTime: null, runnerName: null });
          return { success: false, error: errorMessage };
        }
      } finally {
        setIsRemoteRunning(false);
      }
    };
    const handleRun = async (options?: { sqlText?: string; formatBeforeRun?: boolean }) => {
      const nextSql = typeof options?.sqlText === "string" ? options.sqlText : text;
      const shouldFormatBeforeRun = options?.formatBeforeRun ?? typeof options?.sqlText !== "string";
      dispatchSQLShapeRunStarted(shape.id, nextSql);

      try {
        const result = shouldFormatBeforeRun
          ? await runQueryLogic(handleFormat(nextSql) || nextSql)
          : await runQueryLogic(nextSql);
        dispatchSQLShapeRunFinished(shape.id, result);
        return result;
      } catch (error) {
        dispatchSQLShapeRunFinished(shape.id, {
          success: false,
          error: error instanceof Error ? error.message : "Query failed.",
        });
        throw error;
      }
    };

    const handleCancel = () => {
      if (!isRemoteRunning) return;
      cancelRemoteQuery(shape.id, shape.props.name);
      update({ isRunning: false, error: null, queryStartTime: null, runnerName: null });
    };

    const handleChainQuery = () => {
      const newShapeId = createShapeId();

      this.editor.createShape({
        type: "sql-text-area",
        id: newShapeId,
        x: shape.x + shape.props.w + 60,
        y: shape.y,
        props: {
          text: `SELECT\n  *\nFROM\n  ${shape.props.name}`,
          _isProgrammatic: true,
        },
      });
      connectShapes(this.editor, shape.id, newShapeId);

      setTimeout(() => {
        this.editor.select(newShapeId);
        this.editor.zoomToSelection({ animation: { duration: 250 } });
      }, 50);
    };

    const handleCreateChart = async () => {
      if (shape.props.isDirty) {
        await handleRun();
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
      try {
        let formattedSql = "";
        if (typeof overrideText === "string") {
          formattedSql = overrideText;
        } else {
          const messySql = shape.props.text;
          formattedSql = format(messySql, {
            language: "duckdb", // Always specify a dialect for best results
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
          height: "100%",
          boxSizing: "border-box",
          overflow: "visible", // Allow tooltips to spill out
          fontFamily: "Inter, sans-serif",
        }}
      >
        <ShapeEngineTabs
          tabs={queryExecutionState.tabs}
          style={{
            position: "absolute",
            top: -46,
            left: 0,
            right: 0,
          }}
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
            hasFooter={hasFooter}
            isRemoteRunning={isRemoteRunning}
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
