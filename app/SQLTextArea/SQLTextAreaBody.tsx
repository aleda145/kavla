import type { EditorValidationIssue } from "./editor-validation";
import { LazySQLEditor } from "./LazySQLEditor";
import { SQLTextAreaActionBar } from "./SQLTextAreaActionBar";
import type { SQLTextAreaShape } from "./sql-text-area-types";

interface SQLTextAreaBodyProps {
  hasFooter: boolean;
  isRemoteRunning: boolean;
  shape: SQLTextAreaShape;
  text: string;
  onCancel: () => void;
  onChainQuery: () => void;
  onCreateChart: () => void;
  onFormat: (value?: string) => void;
  onRun: () => void;
  onTextChange: (value: string) => void;
  onToggleTable: () => void;
  validator: (sql: string) => Promise<EditorValidationIssue | null>;
}

export function SQLTextAreaBody({
  hasFooter,
  isRemoteRunning,
  shape,
  text,
  onCancel,
  onChainQuery,
  onCreateChart,
  onFormat,
  onRun,
  onTextChange,
  onToggleTable,
  validator,
}: SQLTextAreaBodyProps) {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          borderBottomLeftRadius: hasFooter ? 0 : 8,
          overflow: "hidden",
        }}
      >
        <LazySQLEditor
          shapeId={shape.id}
          text={text}
          onChange={onTextChange}
          onRun={onRun}
          onFormat={onFormat}
          validator={validator}
        />
      </div>

      <SQLTextAreaActionBar
        hasFooter={hasFooter}
        isRemoteRunning={isRemoteRunning}
        shape={shape}
        onCancel={onCancel}
        onChainQuery={onChainQuery}
        onCreateChart={onCreateChart}
        onRun={onRun}
        onToggleTable={onToggleTable}
      />
    </div>
  );
}
