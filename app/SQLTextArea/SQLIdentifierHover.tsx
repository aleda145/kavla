import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEditor, type TLShapeId } from "tldraw";
import { useData } from "../client/useLocalServer";
import type { DataSourceShape } from "../DataSource/data-source-types";
import { getRemoteSourceMetadata } from "../DataSource/remote-source-metadata";
import { getColumnTypeMutedColor } from "../util/column-colors";
import { ColumnHoverTooltip } from "./ColumnHoverTooltip";
import type { RemoteSourceInfo } from "./remote-column-stats";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { SQLHighlightTarget } from "./StaticSQLHighlighter";
import { buildRemoteSQLFromDag, walkSQLDag } from "./walkSQLDag";

export function SQLIdentifierHover({
  target,
  tableId,
  columns,
  children,
}: {
  target: SQLHighlightTarget;
  tableId?: TLShapeId;
  columns?: { name: string; type: string }[];
  children: ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(timer.current);
  const closeSoon = () => {
    cancelClose();
    timer.current = setTimeout(() => setRect(null), 300);
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!rect) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      setRect(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRect(null);
    };
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("wheel", dismiss, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [rect]);

  return (
    <span
      tabIndex={0}
      title=""
      role="button"
      aria-label={target.kind === "column" ? `${target.column.name}: ${target.column.type}` : target.tableName}
      aria-haspopup="dialog"
      aria-expanded={Boolean(rect)}
      style={{ cursor: "help" }}
      onPointerEnter={(event) => {
        cancelClose();
        setRect(event.currentTarget.getBoundingClientRect());
      }}
      onPointerLeave={closeSoon}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        cancelClose();
        setRect(event.currentTarget.getBoundingClientRect());
      }}
      onFocus={(event) => {
        cancelClose();
        setRect(event.currentTarget.getBoundingClientRect());
      }}
      onBlur={(event) => {
        if (!popup.current?.contains(event.relatedTarget)) closeSoon();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") setRect(null);
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          setRect(event.currentTarget.getBoundingClientRect());
        }
      }}
    >
      {children}
      {rect &&
        createPortal(
          <div
            ref={popup}
            data-sql-identifier-tooltip
            role="dialog"
            aria-label={
              target.kind === "column" ? `${target.column.name} column details` : `${target.tableName} schema`
            }
            tabIndex={0}
            onPointerEnter={cancelClose}
            onPointerLeave={closeSoon}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onFocus={(event) => {
              event.stopPropagation();
              cancelClose();
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) closeSoon();
            }}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(rect.left, window.innerWidth - 420)),
              top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 360)),
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "min(350px, calc(100vh - 16px))",
              overflow: "auto",
              pointerEvents: "all",
              zIndex: 1000000,
            }}
          >
            {target.kind === "column" ? (
              <ColumnDetails column={target.column} tableId={tableId} />
            ) : (
              <div className="border-2 border-black rounded bg-white text-xs shadow-[4px_4px_0px_0px_#000] p-2">
                <strong>{target.tableName}</strong>
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th className="text-left pr-4">Column</th>
                      <th className="text-left">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns?.map((column) => (
                      <tr key={column.name}>
                        <td className="pr-4 py-1 font-mono">{column.name}</td>
                        <td>
                          <span className={getColumnTypeMutedColor(column.type)}>{column.type}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}

function ColumnDetails({
  column,
  tableId,
}: {
  column: { name: string; type: string; tableName: string };
  tableId?: TLShapeId;
}) {
  const editor = useEditor();
  const { runRemoteQuery, cancelRemoteQuery } = useData();
  const remoteSource = useMemo<RemoteSourceInfo | null>(() => {
    const shape = tableId ? editor.getShape(tableId) : undefined;
    if (shape?.type === "data-source") {
      const source = getRemoteSourceMetadata(shape as DataSourceShape);
      return source
        ? {
            sourceName: source.sourceName,
            sourceType: source.sourceType,
            fullTableRef: source.remoteTableRef,
            runRemoteQuery,
            cancelRemoteQuery,
          }
        : null;
    }
    if (shape?.type !== "sql-text-area") return null;
    const query = shape as SQLTextAreaShape;
    const dag = walkSQLDag(editor, query.props.text);
    if (!dag.ok) return null;
    const { executionState, orderedDependencies } = dag.plan;
    const tableSql = buildRemoteSQLFromDag(query.props.text, orderedDependencies, editor);
    return {
      sourceName: executionState.sourceName ?? "uploaded_files",
      sourceType: executionState.sourceNativePreview ? executionState.sourceType : "duckdb",
      fullTableRef: `query:${query.id}:${tableSql}`,
      tableSql,
      runRemoteQuery,
      cancelRemoteQuery,
    };
  }, [editor, tableId, runRemoteQuery, cancelRemoteQuery]);

  return (
    <ColumnHoverTooltip
      columnName={column.name}
      type={column.type}
      tableName={column.tableName}
      remoteSource={remoteSource}
    />
  );
}
