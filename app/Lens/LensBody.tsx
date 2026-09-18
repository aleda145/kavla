import type { ReactNode } from "react";
import type { TLShapeId } from "tldraw";
import { GeneratedChartWidgetView } from "../Chart/GeneratedChartWidget";
import type { EditorValidationIssue } from "../SQLTextArea/editor-validation";
import { LensCodeMirror } from "./LensCodeMirror";
import { LensModeBar } from "./LensModeBar";
import { LensWidgetSurface } from "./LensWidgetSurface";
import type { LensViewMode } from "./lens-view-mode";

interface LensBodyProps {
  isSampled: boolean;
  code: string;
  columnTypes: Record<string, string>;
  columns: string[];
  data: Record<string, unknown>[];
  dataSql: string | null;
  defaultDataSql: string;
  isStatusError: boolean;
  shapeId: TLShapeId;
  sourceName: string;
  statusMessage: string | null;
  viewMode: LensViewMode;
  widgetHeight: number;
  widgetKey: string;
  widgetWidth: number;
  onCodeChange: (nextCode: string) => void;
  onDataSqlChange: (nextDataSql: string) => void;
  onDataSqlError: (errorMessage: string) => void;
  onDataSqlFormat: (value?: string) => void;
  onDataSqlValidate: (sql: string) => Promise<EditorValidationIssue | null>;
  onShowCode: () => void;
  onShowLens: () => void;
  onShowSql: () => void;
  onWidgetError: (errorMessage: string) => void;
}

function LensEditorPane({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#fff",
        overflow: "auto",
        pointerEvents: "all",
        userSelect: "text",
      }}
    >
      {children}
    </div>
  );
}

function LensStatusMessage({ children, isError }: { children: string; isError: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 18,
        boxSizing: "border-box",
        fontWeight: 900,
        color: isError ? "#991b1b" : "#111827",
      }}
    >
      {children}
    </div>
  );
}

export function LensBody({
  isSampled,
  code,
  columnTypes,
  columns,
  data,
  dataSql,
  defaultDataSql,
  isStatusError,
  shapeId,
  sourceName,
  statusMessage,
  viewMode,
  widgetHeight,
  widgetKey,
  widgetWidth,
  onCodeChange,
  onDataSqlChange,
  onDataSqlError,
  onDataSqlFormat,
  onDataSqlValidate,
  onShowCode,
  onShowLens,
  onShowSql,
  onWidgetError,
}: LensBodyProps) {
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0 }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
        {viewMode === "code" ? (
          <LensEditorPane>
            <LensCodeMirror
              shapeId={shapeId}
              value={code || "// Lens has no generated code yet."}
              onChange={onCodeChange}
              language="typescript"
            />
          </LensEditorPane>
        ) : viewMode === "sql" ? (
          <LensEditorPane>
            <LensCodeMirror
              shapeId={shapeId}
              value={dataSql || defaultDataSql}
              onChange={onDataSqlChange}
              language="sql"
              onFormat={onDataSqlFormat}
              validator={onDataSqlValidate}
            />
          </LensEditorPane>
        ) : statusMessage ? (
          <LensStatusMessage isError={isStatusError}>{statusMessage}</LensStatusMessage>
        ) : (
          <LensWidgetSurface>
            <GeneratedChartWidgetView
              isSampled={isSampled}
              code={code}
              dataSql={dataSql}
              widgetKey={widgetKey}
              rows={data}
              columns={columns}
              columnTypes={columnTypes}
              sourceName={sourceName}
              width={widgetWidth}
              height={widgetHeight}
              onError={onWidgetError}
              onDataSqlError={onDataSqlError}
            />
          </LensWidgetSurface>
        )}
      </div>
      <LensModeBar viewMode={viewMode} onShowCode={onShowCode} onShowLens={onShowLens} onShowSql={onShowSql} />
    </div>
  );
}
