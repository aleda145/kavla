import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownWideNarrow,
  Blocks,
  Brush,
  Calculator,
  Columns3,
  Combine,
  Database,
  FileQuestion,
  Filter,
  GitBranch,
  GitMerge,
  Layers,
  ListFilter,
  Sigma,
  type LucideIcon,
} from "lucide-react";
import {
  getSQLBizCardWidth,
  getSQLBizColumns,
  getSQLBizSummary,
  SQL_BIZ_CARD_GAP,
  type BizOperation,
} from "./sqlBizSummary";

import { useSchemaRegistry } from "../hooks/useSchemaRegistry";
import { buildSqlSchemaIndex } from "./schema-index";
import { StaticSQLHighlighter, type SQLHighlightTarget } from "./StaticSQLHighlighter";
import { SQLIdentifierHover } from "./SQLIdentifierHover";
import type { SQLTextAreaShape } from "./sql-text-area-types";

const operations: Record<BizOperation, { Icon: LucideIcon; color: string }> = {
  READ: { Icon: Database, color: "#bfdbfe" },
  JOIN: { Icon: GitMerge, color: "#fed7aa" },
  FILTER: { Icon: Filter, color: "#99f6e4" },
  CALCULATE: { Icon: Calculator, color: "#fde68a" },
  BUCKET: { Icon: Blocks, color: "#fed7aa" },
  CLEAN: { Icon: Brush, color: "#99f6e4" },
  CONDITIONAL: { Icon: GitBranch, color: "#fecaca" },
  AGGREGATE: { Icon: Sigma, color: "#fbcfe8" },
  "FILTER GROUPS": { Icon: Filter, color: "#99f6e4" },
  WINDOW: { Icon: Layers, color: "#a5f3fc" },
  "FILTER WINDOW": { Icon: Filter, color: "#99f6e4" },
  SELECT: { Icon: Columns3, color: "#fef08a" },
  DEDUPLICATE: { Icon: Layers, color: "#d9f99d" },
  SORT: { Icon: ArrowDownWideNarrow, color: "#bbf7d0" },
  SKIP: { Icon: ListFilter, color: "#e7e5e4" },
  LIMIT: { Icon: ListFilter, color: "#bae6fd" },
  COMBINE: { Icon: Combine, color: "#cbd5e1" },
};

export function SQLBizBody({ text, shape }: { text: string; shape: SQLTextAreaShape }) {
  const registry = useSchemaRegistry();
  const schema = useMemo(() => buildSqlSchemaIndex(registry), [registry]);
  const upstreamTableNames = (shape.props.upstreamShapeIds ?? []).flatMap((id) => {
    const entry = registry[id];
    return entry ? [entry.tableName] : [];
  });
  const renderIdentifier = (content: ReactNode, target: SQLHighlightTarget) => {
    const tableName = target.kind === "column" ? target.column.tableName : target.tableName;
    return (
      <SQLIdentifierHover
        target={target}
        tableId={schema.tableNameToId.get(tableName)}
        columns={schema.fullSchemaConfig[tableName]}
      >
        {content}
      </SQLIdentifierHover>
    );
  };
  const highlight = (sql: string) => (
    <StaticSQLHighlighter
      inline
      sql={sql}
      contextSql={text}
      validTableNames={schema.tableNames}
      sources={schema.sources}
      queries={schema.queries}
      columnMapping={schema.columnMapping}
      upstreamTableNames={upstreamTableNames}
      renderIdentifier={renderIdentifier}
    />
  );
  const summary = getSQLBizSummary(text);
  const tooltipId = useId();
  const container = useRef<HTMLDivElement>(null);
  const errorMessage = useRef<HTMLPreElement>(null);
  const [available, setAvailable] = useState({ w: 0, h: 0 });
  const columns = getSQLBizColumns(summary, available);
  const grid = columns.length > 1 && columns.length < summary.steps.length;

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const errorHeight = errorMessage.current ? errorMessage.current.offsetHeight + 12 : 0;
      const next = {
        w: Math.max(0, element.clientWidth - 28),
        h: Math.max(0, element.clientHeight - 24 - errorHeight),
      };
      setAvailable((previous) => (previous.w === next.w && previous.h === next.h ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (errorMessage.current) observer.observe(errorMessage.current);
    return () => observer.disconnect();
  }, [summary.error]);
  const popover = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<{ index: number; rect: DOMRect } | null>(null);
  const activeStep = detail ? summary.steps[detail.index] : undefined;

  useEffect(() => setDetail(null), [text, available.w, available.h]);
  useEffect(() => {
    if (!detail) return;
    const dismiss = () => setDetail(null);
    const outside = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-sql-identifier-tooltip]")) return;
      if (event.target instanceof Node && !popover.current?.contains(event.target)) dismiss();
    };
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) outside(event);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", escape);
    window.addEventListener("wheel", outside, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("wheel", outside, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [detail]);

  return (
    <div
      ref={container}
      aria-label="Query pipeline"
      onWheel={(event) => event.stopPropagation()}
      onScroll={() => setDetail(null)}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        padding: "12px 14px",
        background: "#fff",
      }}
    >
      {summary.steps.length ? (
        <ol
          aria-label="Query operations in order"
          style={{
            display: "grid",
            gridTemplateColumns: columns.map((width) => `${width}px`).join(" "),
            alignItems: "start",
            justifyItems: "center",
            gap: SQL_BIZ_CARD_GAP,
            listStyle: "none",
            width: "max-content",
            margin: grid ? "0 auto" : "auto",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {summary.steps.map((step, index) => {
            const { Icon, color } = operations[step.label];
            const label = step.label === "CONDITIONAL" ? "CLASSIFY" : step.label;
            const card = step.card ?? { primary: step.detail };
            const showDetail = (element: HTMLElement) => setDetail({ index, rect: element.getBoundingClientRect() });
            return (
              <li key={index} style={{ display: "flex", minWidth: 0 }}>
                <div
                  role="button"
                  tabIndex={0}
                  title={
                    detail?.index === index
                      ? undefined
                      : `${step.scope ? `${step.scope}\n` : ""}${label}\n${step.detail}`
                  }
                  aria-label={`${step.scope ? `${step.scope}: ` : ""}${label}: ${step.detail}`}
                  aria-describedby={detail?.index === index ? tooltipId : undefined}
                  onPointerDown={(event) => event.stopPropagation()}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) showDetail(event.currentTarget);
                  }}
                  onClick={(event) => showDetail(event.currentTarget)}
                  onBlur={(event) => {
                    if (
                      event.relatedTarget instanceof Element &&
                      event.relatedTarget.closest("[data-sql-identifier-tooltip]")
                    )
                      return;
                    if (
                      !event.currentTarget.contains(event.relatedTarget) &&
                      !popover.current?.contains(event.relatedTarget)
                    )
                      setDetail(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") setDetail(null);
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      showDetail(event.currentTarget);
                    }
                  }}
                  className="hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    width: getSQLBizCardWidth(step),
                    minHeight: 82,
                    padding: "9px 8px",
                    boxSizing: "border-box",
                    border: "2px solid #000",
                    borderRadius: 12,
                    background: "#fff",
                    color: "#000",
                    textAlign: "left",
                    fontFamily: "Inter, sans-serif",
                    cursor: "pointer",
                  }}
                >
                  {step.scope && (
                    <span
                      style={{
                        fontSize: 9,
                        color: "#525252",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        marginBottom: 4,
                      }}
                    >
                      {step.scope}
                    </span>
                  )}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 10,
                      lineHeight: "14px",
                      fontWeight: 800,
                      marginBottom: 8,
                      alignSelf: "flex-start",
                      padding: "3px 6px",
                      borderRadius: 999,
                      border: "1px solid #000",
                      background: color,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Icon size={13} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
                    {label}
                  </span>
                  <span
                    style={{
                      whiteSpace: "pre",
                      fontSize: 12,
                      lineHeight: "16px",
                      fontWeight: 700,
                    }}
                  >
                    {highlight(card.primary)}
                  </span>
                  {card.secondary && (
                    <span
                      style={{
                        fontSize: 10,
                        lineHeight: "14px",
                        color: "#444",
                        marginTop: 3,
                        whiteSpace: "pre",
                      }}
                    >
                      {highlight(card.secondary)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : !summary.error ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#737373",
            padding: "12px 0",
          }}
        >
          <FileQuestion size={22} aria-hidden />
          <span style={{ fontSize: 12 }}>{summary.note ?? "No query yet."}</span>
        </div>
      ) : null}
      {summary.error && (
        <pre
          ref={errorMessage}
          role="alert"
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            margin: summary.steps.length ? "12px 0 0" : 0,
            fontSize: 12,
            color: "#b91c1c",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            userSelect: "text",
            flexShrink: 0,
          }}
        >
          {summary.error}
        </pre>
      )}
      {detail &&
        activeStep &&
        createPortal(
          <div
            ref={popover}
            id={tooltipId}
            role="tooltip"
            tabIndex={0}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Element &&
                event.relatedTarget.closest("[data-sql-identifier-tooltip]")
              )
                return;
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                !container.current?.contains(event.relatedTarget)
              )
                setDetail(null);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setDetail(null);
            }}
            style={{
              position: "fixed",
              left: Math.max(12, Math.min(detail.rect.left, window.innerWidth - 332)),
              top: Math.max(12, Math.min(detail.rect.bottom + 8, window.innerHeight - 252)),
              width: 320,
              maxHeight: 240,
              overflow: "auto",
              padding: "10px 12px",
              boxSizing: "border-box",
              border: "2px solid #000",
              borderRadius: 8,
              boxShadow: "4px 4px 0 #000",
              background: "#fff",
              color: "#171717",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              pointerEvents: "all",
              zIndex: 999999,
            }}
          >
            <strong>{activeStep.label === "CONDITIONAL" ? "CLASSIFY" : activeStep.label}</strong>
            {activeStep.scope && <div style={{ marginTop: 4, color: "#666" }}>{activeStep.scope}</div>}
            <pre
              style={{
                margin: "6px 0 0",
                fontFamily: "monospace",
                lineHeight: "18px",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                userSelect: "text",
              }}
            >
              {highlight(activeStep.detail)}
            </pre>
          </div>,
          document.body
        )}
    </div>
  );
}
