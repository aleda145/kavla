import { HTMLContainer, Rectangle2d, ShapeUtil, resizeBox, useValue, type TLResizeInfo, type TLShapeId } from "tldraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "sql-formatter";
import type { LensShape } from "./lens-shape-types";
import { LensShapeProps } from "./lens-shape-props";
import { LensShapeMigrations } from "./lens-shape-migrations";
import { LensHeader } from "./LensHeader";
import { LensBody } from "./LensBody";
import type { LensViewMode } from "./lens-view-mode";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { useQueryResultRows } from "../client/useQueryResultRows";
import { useData } from "../client/useLocalServer";
import { restoreRemoteQueryView } from "../SQLTextArea/restoreRemoteQueryView";
import { validateDuckDBSyntax } from "../SQLTextArea/editor-validation";
import { quoteIdentifier } from "../src/duckdb/sql";
import { normalizeChartRow } from "../Chart/chartOptions";

export class LensUtil extends ShapeUtil<LensShape> {
  static override type = "lens-shape" as const;
  static override props = LensShapeProps;
  static override migrations = LensShapeMigrations;
  getDefaultProps(): LensShape["props"] {
    return { sourceShapeId: null, prompt: "", dataSql: null, code: "", title: "Lens", description: null, jobId: null, generatedAt: null, error: null, retryCount: 0, generationStatus: "ready", w: 720, h: 480, name: "Lens" };
  }
  getGeometry(shape: LensShape) { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }); }
  override onResize(shape: LensShape, info: TLResizeInfo<LensShape>) { return resizeBox(shape, info); }
  indicator(shape: LensShape) { return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />; }
  component(shape: LensShape) {
    const editor = this.editor;
    const { runRemoteQuery } = useData();
    const [viewMode, setViewMode] = useState<LensViewMode>("lens");
    const failedWidget = useRef<string | null>(null);
    const source = useValue("Lens source", () => {
      const value = shape.props.sourceShapeId ? editor.getShape(shape.props.sourceShapeId as TLShapeId) : undefined;
      return value?.type === "sql-text-area" ? value as SQLTextAreaShape : undefined;
    }, [editor, shape.props.sourceShapeId]);
    const restoreServerResult = useCallback(async () => {
      if (!source) throw new Error("The Lens source is unavailable.");
      await restoreRemoteQueryView(editor, source, runRemoteQuery);
    }, [editor, source, runRemoteQuery]);
    const rows = useQueryResultRows({ sourceShapeId: source?.id || null, sourceTableName: source?.props.name || null, schema: source?.props.outputSchema, revision: source?.props.lastRunStats, normalizeRow: normalizeChartRow, serverResultShapeId: source?.id ?? null, restoreServerResult });
    const widgetKey = `${shape.id}:${shape.props.generatedAt}:${shape.props.code}:${shape.props.dataSql}`;
    const update = (props: Partial<LensShape["props"]>) => editor.updateShape<LensShape>({ id: shape.id, type: "lens-shape", props });
    const reportError = (error: string) => {
      const current = editor.getShape<LensShape>(shape.id);
      if (!current || ["generating", "repairing"].includes(current.props.generationStatus) || failedWidget.current === widgetKey) return;
      failedWidget.current = widgetKey;
      update({ error, generationStatus: "error" });
      // Rendering reports an error only. Retrying requires an explicit user request.
    };
    useEffect(() => {
      const onView = (event: Event) => {
        const detail = (event as CustomEvent<{ shapeId: string; viewMode: LensViewMode }>).detail;
        if (detail?.shapeId === shape.id) setViewMode(detail.viewMode);
      };
      window.addEventListener("kavla:lens-view-mode", onView);
      return () => window.removeEventListener("kavla:lens-view-mode", onView);
    }, [shape.id]);
    const generating = ["generating", "repairing"].includes(shape.props.generationStatus);
    const status = !source ? "Connect this Lens to a visible query." : source.props.isDirty || source.props.stale ? "Run the source query to refresh this Lens." : rows.isLoading ? "Loading query results…" : rows.error || (shape.props.generationStatus === "error" ? shape.props.error || "Lens failed. Edit the code or ask the Agent to repair it." : null) || (!shape.props.code ? generating ? "Generating Lens…" : shape.props.error || "Ask the Agent to create a Lens." : null);
    return <HTMLContainer id={shape.id} onWheel={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", pointerEvents: "all", border: "4px solid #000", borderRadius: 12, overflow: "hidden", background: "#fff", boxSizing: "border-box", fontFamily: "Inter, sans-serif" }}>
      <LensHeader title={shape.props.title || shape.props.name} description={shape.props.description} hasRetryStatus={generating} />
      <LensBody isSampled={rows.isTruncated} code={shape.props.code} dataSql={shape.props.dataSql} defaultDataSql={`SELECT * FROM ${quoteIdentifier(source?.props.name || "data")}`} shapeId={shape.id} sourceName={source?.props.name || "data"} data={rows.data} columns={rows.columns} columnTypes={rows.columnTypes} widgetKey={widgetKey} widgetWidth={Math.max(1, shape.props.w - 48)} widgetHeight={Math.max(1, shape.props.h - 74)} viewMode={viewMode} statusMessage={status} isStatusError={Boolean(rows.error || shape.props.error)}
        onShowCode={() => setViewMode("code")} onShowLens={() => setViewMode("lens")} onShowSql={() => setViewMode("sql")}
        onCodeChange={(code) => update({ code, error: null, generationStatus: "ready", retryCount: 0 })}
        onDataSqlChange={(dataSql) => update({ dataSql: dataSql.trim() ? dataSql : null, error: null, generationStatus: "ready", retryCount: 0 })}
        onDataSqlFormat={(sql) => { try { update({ dataSql: format(sql || shape.props.dataSql || `SELECT * FROM ${quoteIdentifier(source?.props.name || "data")}`, { language: "duckdb" }) }); } catch (error) { update({ error: String(error) }); } }}
        onDataSqlValidate={async (sql) => sql.trim() ? validateDuckDBSyntax(sql) : { message: "SQL is required." }}
        onWidgetError={reportError} onDataSqlError={reportError} />
      <div style={{ fontSize: 10, padding: "4px 8px", borderTop: "1px solid #d6d3d1", color: shape.props.error ? "#991b1b" : "#57534e" }}>
        {generating ? "Generating Lens… " : shape.props.error ? `${shape.props.error} ` : ""}{`${rows.data.length.toLocaleString()} rows from ${source?.props.name || "query"}.`} Presentation SQL uses these rows.
      </div>
    </HTMLContainer>;
  }
}
