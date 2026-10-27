import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { format } from "sql-formatter";
import { useEditor, useToasts, useValue } from "tldraw";
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
  X,
  type LucideIcon,
} from "lucide-react";
import {
  getSQLBizCardWidth,
  getSQLBizColumns,
  getSQLBizSummary,
  getSQLBizStep,
  getSQLBizGroupLayout,
  SQL_BIZ_CARD_GAP,
  type BizOperation,
  type BizStep,
} from "./sqlBizSummary";

import { useSchemaRegistry } from "../hooks/useSchemaRegistry";
import { buildSqlSchemaIndex } from "./schema-index";
import { StaticSQLHighlighter, type SQLHighlightTarget } from "./StaticSQLHighlighter";
import { SQLIdentifierHover } from "./SQLIdentifierHover";
import { usePopupPlacement } from "./usePopupPlacement";
import { useExclusivePopup } from "./useExclusivePopup";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { extractSQLBizOperation, getSQLBizExtractionPlan, isSQLBizExtracting } from "./extractSQLBizOperation";
import { useData } from "../client/useLocalServer";
import { useSQLBizFilterStats } from "./useSQLBizStats";
import { formatBizFilterCount, type BizFilterPlan } from "./sqlBizFilterStats";
import { SQLBizOperationStats } from "./SQLBizOperationStats";
import { SQLBizAnalysisControls } from "./SQLBizAnalysisControls";

const operations: Record<BizOperation, { Icon: LucideIcon; color: string }> = {
  CTE: { Icon: Layers, color: "#bfdbfe" },
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

function OperationBadge({ operation }: { operation: BizOperation }) {
  const { Icon, color } = operations[operation];
  const label = operation === "CONDITIONAL" ? "CLASSIFY" : operation;
  return (
    <span
      style={{
        display: "inline-flex",
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
  );
}

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
        ownerShapeId={shape.id}
        tableId={schema.tableNameToId.get(tableName)}
        columns={schema.fullSchemaConfig[tableName]}
      >
        {content}
      </SQLIdentifierHover>
    );
  };
  const highlight = (sql: string, interactive = true) => (
    <StaticSQLHighlighter
      inline
      sql={sql}
      contextSql={text}
      validTableNames={schema.tableNames}
      sources={schema.sources}
      queries={schema.queries}
      columnMapping={schema.columnMapping}
      upstreamTableNames={upstreamTableNames}
      renderIdentifier={interactive ? renderIdentifier : undefined}
    />
  );
  const summary = getSQLBizSummary(text);
  const container = useRef<HTMLDivElement>(null);
  const draggingScrollbar = useRef(false);
  useEffect(() => {
    const release = () => {
      draggingScrollbar.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
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
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [pinned, setPinned] = useState<OperationDetail | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHoverTimer = () => clearTimeout(hoverTimer.current);
  const claimPopup = useExclusivePopup(Boolean(detail), () => {
    clearTimeout(hoverTimer.current);
    setDetail(null);
  });
  const claimPinnedPopup = useExclusivePopup(Boolean(pinned), () => setPinned(null), "pinned");
  const pinDetail = (next: OperationDetail) => {
    cancelHoverTimer();
    if (claimPinnedPopup(next.anchor)) {
      setDetail(null);
      setPinned(next);
    }
  };
  const closeHoverSoon = () => {
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => setDetail(null), 600);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    clearTimeout(hoverTimer.current);
    setDetail(null);
    setPinned(null);
  }, [text]);
  useEffect(() => {
    if (!detail && !pinned) return;
    const dismiss = () => {
      clearTimeout(hoverTimer.current);
      setDetail(null);
      setPinned(null);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-sql-popup], [data-sql-biz-card]")) return;
      dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [detail, pinned]);

  const pinnedStep = pinned ? getSQLBizStep(summary, pinned.path) : undefined;
  const activeStep = detail ? getSQLBizStep(summary, detail.path) : undefined;
  const renderStep = (step: BizStep, path: number[], availableWidth: number): ReactNode => {
    const group = step.children ? getSQLBizGroupLayout(step, availableWidth) : null;
    const label = step.label === "CONDITIONAL" ? "CLASSIFY" : step.label;
    const card = step.card ?? { primary: step.detail };
    const showDetail = (anchor: HTMLElement) => {
      pinDetail({ path, anchor });
    };
    const showHover = (anchor: HTMLElement) => {
      cancelHoverTimer();
      if (pinned?.path.join(".") === path.join(".")) return;
      hoverTimer.current = setTimeout(() => {
        if (claimPopup(anchor)) setDetail({ path, anchor });
      }, 200);
    };
    return (
      <li key={path.join(".")} style={{ display: "flex", minWidth: 0 }}>
        <div
          role="button"
          tabIndex={0}
          data-sql-biz-card
          onPointerEnter={(event) => {
            if (
              !(event.target instanceof Element) ||
              event.target.closest("[data-sql-biz-card]") !== event.currentTarget
            )
              return;
            if (event.target instanceof Element && event.target.closest("[data-sql-identifier]")) return;
            showHover(event.currentTarget);
          }}
          onPointerOver={(event) => {
            if (
              !(event.target instanceof Element) ||
              event.target.closest("[data-sql-biz-card]") !== event.currentTarget
            )
              return;
            if (event.target instanceof Element && event.target.closest("[data-sql-identifier]")) {
              cancelHoverTimer();
              setDetail(null);
            } else if (group) showHover(event.currentTarget);
          }}
          onPointerLeave={closeHoverSoon}
          aria-label={`${step.scope ? `${step.scope}: ` : ""}${label}: ${step.detail}`}
          aria-expanded={pinned?.path.join(".") === path.join(".") || detail?.path.join(".") === path.join(".")}
          aria-haspopup="dialog"
          onPointerDown={(event) => event.stopPropagation()}
          onFocus={(event) => {
            if (event.target === event.currentTarget) showDetail(event.currentTarget);
          }}
          onClick={(event) => {
            event.stopPropagation();
            showDetail(event.currentTarget);
          }}
          onBlur={closeHoverSoon}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              setDetail(null);
              setPinned(null);
            }
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
            width: getSQLBizCardWidth(step, availableWidth),
            minHeight: 82,
            padding: group ? "10px" : "9px 8px",
            boxSizing: "border-box",
            border: group ? "2px dashed #000" : "2px solid #000",
            borderRadius: 12,
            background: "#fff",
            color: "#000",
            textAlign: "left",
            fontFamily: "Inter, sans-serif",
            cursor: "pointer",
          }}
        >
          {step.scope && path.length === 1 && (
            <span
              style={{
                fontSize: 9,
                color: "#000",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                marginBottom: 4,
              }}
            >
              {step.scope}
            </span>
          )}
          {group ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <OperationBadge operation="CTE" />
                <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 700 }}>{card.primary}</span>
              </div>
              <ol
                aria-label={`${step.cteName} CTE operations`}
                style={{
                  display: "grid",
                  gridTemplateColumns: group.columns.map((width) => `${width}px`).join(" "),
                  gap: SQL_BIZ_CARD_GAP,
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  alignItems: "start",
                }}
              >
                {step.children?.map((child, index) =>
                  renderStep(child, [...path, index], group.columns[index % group.columns.length])
                )}
              </ol>
            </>
          ) : (
            <>
              <OperationBadge operation={step.label} />
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
              {card.secondary &&
                !(step.stats && step.label === "CONDITIONAL" && /^\d+ groups$/.test(card.secondary)) && (
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: "14px",
                      color: "#000",
                      marginTop: 3,
                      whiteSpace: "pre",
                    }}
                  >
                    {highlight(card.secondary)}
                  </span>
                )}
              {step.filter && <FilterCounts shape={shape} plan={step.filter} />}
              {step.stats && <SQLBizOperationStats shape={shape} plan={step.stats} />}
            </>
          )}
        </div>
      </li>
    );
  };

  return (
    <div
      ref={container}
      data-sql-biz-body
      aria-label="Query pipeline"
      onPointerDown={(event) => {
        const element = event.currentTarget;
        if (event.target !== element) return;
        const rect = element.getBoundingClientRect();
        const x = ((event.clientX - rect.left) * element.offsetWidth) / rect.width;
        const y = ((event.clientY - rect.top) * element.offsetHeight) / rect.height;
        // Include overlay scrollbars, whose width may not appear in clientWidth/clientHeight.
        const vertical =
          element.scrollHeight > element.clientHeight &&
          x >= element.offsetWidth - Math.max(16, element.offsetWidth - element.clientWidth);
        const horizontal =
          element.scrollWidth > element.clientWidth &&
          y >= element.offsetHeight - Math.max(16, element.offsetHeight - element.clientHeight);
        draggingScrollbar.current = vertical || horizontal;
        if (draggingScrollbar.current) event.stopPropagation();
      }}
      onPointerMove={(event) => {
        if (draggingScrollbar.current) event.stopPropagation();
      }}
      onPointerUp={(event) => {
        if (draggingScrollbar.current) event.stopPropagation();
        draggingScrollbar.current = false;
      }}
      onPointerCancel={() => {
        draggingScrollbar.current = false;
      }}
      onWheel={(event) => event.stopPropagation()}
      onScroll={() => {
        cancelHoverTimer();
        setDetail(null);
      }}
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
          {summary.steps.map((step, index) => renderStep(step, [index], available.w))}
        </ol>
      ) : !summary.error ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            color: "#000",
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
      {pinned && pinnedStep && (
        <OperationPopup
          detail={pinned}
          step={pinnedStep}
          pinned
          shape={shape}
          text={text}
          highlight={highlight}
          onClose={() => setPinned(null)}
          onPointerEnter={cancelHoverTimer}
          onPointerLeave={() => {}}
        />
      )}
      {detail && detail.path.join(".") !== pinned?.path.join(".") && activeStep && (
        <OperationPopup
          detail={detail}
          step={activeStep}
          pinned={false}
          shape={shape}
          text={text}
          highlight={highlight}
          onClose={() => setDetail(null)}
          onPointerEnter={cancelHoverTimer}
          onPointerLeave={closeHoverSoon}
        />
      )}
    </div>
  );
}

type OperationDetail = { path: number[]; anchor: HTMLElement };

function FilterCounts({
  shape,
  plan,
  perCondition = false,
  popup = false,
  highlight,
}: {
  shape: SQLTextAreaShape;
  plan: BizFilterPlan;
  perCondition?: boolean;
  popup?: boolean;
  highlight?: (sql: string, interactive?: boolean) => ReactNode;
}) {
  const analysis = useSQLBizFilterStats(shape, plan, perCondition);
  const { state } = analysis;
  const percentage = (removed: number, input: number) => (
    <span
      title={`${removed.toLocaleString()} of ${input.toLocaleString()} input rows removed`}
      aria-label={`${removed.toLocaleString()} of ${input.toLocaleString()} input rows removed`}
      tabIndex={0}
      className="font-mono text-[10px] font-bold text-black tabular-nums text-right"
      style={{ whiteSpace: "nowrap", cursor: "help" }}
    >
      {(input ? (100 * removed) / input : 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%
    </span>
  );
  return (
    <div
      aria-live="polite"
      style={{ marginTop: 6, fontSize: popup ? 12 : 10, lineHeight: "14px", overflowWrap: "anywhere" }}
    >
      {popup && !("error" in plan) && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 8, lineHeight: "20px" }}>
          {plan.conditions.map((condition, index) => (
            <div key={index} style={{ display: "contents" }}>
              <span style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", userSelect: "text" }}>
                {highlight ? highlight(`${index ? "AND " : ""}${condition}`, false) : condition}
              </span>
              {perCondition && state.status === "ready" ? (
                percentage(state.counts.conditions[index], state.counts.input)
              ) : (
                <span
                  className="font-mono text-[10px] text-black text-right"
                  title={state.status === "loading" ? "Counting rows removed" : undefined}
                >
                  {state.status === "loading" ? "…" : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {!popup && state.status === "loading" && <span className="font-mono text-[10px] text-black">Counting rows…</span>}
      {!popup && state.status === "waiting" && (
        <span className="font-mono text-[10px] text-black">Waiting for query…</span>
      )}
      {state.status === "error" && <div className="text-xs font-bold text-red-500">{state.error}</div>}
      {state.status === "ready" &&
        (popup ? (
          <div className="flex justify-between items-center gap-2 mt-1 pt-1 border-t border-gray-200">
            <span className="font-mono text-[10px] text-black">Total removed</span>
            {percentage(state.counts.removed, state.counts.input)}
          </div>
        ) : (
          <div>{formatBizFilterCount(state.counts.removed, state.counts.input)}</div>
        ))}
      {popup && !("error" in plan) && <SQLBizAnalysisControls {...analysis} loading={state.status === "loading"} />}
    </div>
  );
}

function OperationPopup({
  detail,
  step,
  pinned,
  shape,
  text,
  highlight,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  detail: OperationDetail;
  step: BizStep;
  pinned: boolean;
  shape: SQLTextAreaShape;
  text: string;
  highlight: (sql: string, interactive?: boolean) => ReactNode;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const editor = useEditor();
  const data = useData();
  const { addToast } = useToasts();
  const extracting = useValue("SQL extraction running", () => isSQLBizExtracting(editor, shape.id), [editor, shape.id]);
  const tooltipId = useId();
  const popover = useRef<HTMLDivElement>(null);
  const position = usePopupPlacement(detail.anchor, popover, shape.id);
  const filterPlan = step.filter && !("error" in step.filter) ? step.filter : null;
  const popupWidth = filterPlan
    ? Math.min(
        640,
        Math.max(
          320,
          ...filterPlan.conditions.map((condition, index) => (condition.length + (index ? 4 : 0)) * 7.3 + 90)
        )
      )
    : 320;
  const extraction = useValue(
    "Biz operation extraction",
    () => getSQLBizExtractionPlan(editor, shape.id, detail.path),
    [editor, shape.id, detail.path]
  );
  const formattedDetail = useMemo(() => {
    if (!step) return { sql: "", error: null };
    try {
      return {
        sql: format(step.detail, {
          language: "duckdb",
          keywordCase: "upper",
          tabWidth: 2,
          expressionWidth: 40,
          paramTypes: {
            custom: [
              { regex: "\\{[A-Za-z_][A-Za-z0-9_]*\\}" },
              // Keep the summary's separators alongside SQL fragments.
              { regex: "[·∩−]" },
            ],
          },
        }),
        error: null,
      };
    } catch (error) {
      return { sql: step.detail, error: error instanceof Error ? error.message : String(error) };
    }
  }, [step]);

  return createPortal(
    <div
      ref={popover}
      data-sql-popup
      data-sql-popup-pinned={pinned || undefined}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onPointerEnter}
      id={tooltipId}
      role="dialog"
      aria-label={`${step.label} operation details`}
      tabIndex={0}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        ...position,
        width: popupWidth,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: filterPlan || step.stats ? "calc(100vh - 16px)" : "min(240px, calc(100vh - 16px))",
        overflow: "auto",
        padding: "10px 12px",
        boxSizing: "border-box",
        border: "2px solid #000",
        borderRadius: 8,
        boxShadow: "4px 4px 0 #000",
        background: "#fff",
        color: "#000",
        fontFamily: "Inter, sans-serif",
        fontSize: 12,
        pointerEvents: "all",
        zIndex: pinned ? 1000001 : 999999,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <OperationBadge operation={step.label} />
        <span style={{ display: "flex", gap: 8 }}>
          <span
            title={
              extraction.enabled
                ? extraction.direction === "upstream"
                  ? "Extracts Upstream"
                  : "Extract Downstream"
                : extraction.reason
            }
          >
            <button
              type="button"
              disabled={!extraction.enabled || extracting}
              aria-busy={extracting}
              aria-label={extraction.enabled ? `Extract ${extraction.direction}` : "Extract"}
              aria-describedby={extraction.enabled ? undefined : `${tooltipId}-extraction`}
              className="h-7 px-2 rounded border-2 border-black bg-white text-xs font-bold cursor-pointer hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={async (event) => {
                event.stopPropagation();
                if (!extraction?.enabled || extracting) return;
                try {
                  const extracted = await extractSQLBizOperation(editor, shape.id, detail.path, text, data);
                  addToast({
                    title: `Extracted to ${extracted.name}`,
                    severity: "success",
                    actions: [
                      {
                        label: "Go to query",
                        type: "primary",
                        onClick: () => {
                          const bounds = editor.getShapePageBounds(extracted.id);
                          if (!bounds) return;
                          editor.select(extracted.id);
                          editor.zoomToBounds(bounds, {
                            targetZoom: editor.getZoomLevel(),
                            animation: { duration: 250 },
                          });
                        },
                      },
                    ],
                  });
                  onClose();
                } catch (error) {
                  addToast({
                    title: "Could not extract operation",
                    description: error instanceof Error ? error.message : String(error),
                    severity: "error",
                  });
                }
              }}
            >
              {extracting ? "Running SQL…" : "Extract"}
            </button>
          </span>
          {pinned && (
            <button
              type="button"
              aria-label="Close operation details"
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded border-2 border-black bg-white cursor-pointer hover:bg-gray-100"
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </span>
      </div>
      {!extraction.enabled && (
        <span id={`${tooltipId}-extraction`} className="sr-only">
          {extraction.reason}
        </span>
      )}
      {step.scope && <div style={{ marginTop: 4, color: "#000" }}>{step.scope}</div>}
      {!filterPlan && (
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
          {highlight(formattedDetail.sql, false)}
        </pre>
      )}
      {!filterPlan && formattedDetail.error && (
        <pre role="alert" style={{ color: "#b91c1c", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {formattedDetail.error}
        </pre>
      )}
      {step.filter && <FilterCounts shape={shape} plan={step.filter} perCondition popup highlight={highlight} />}
      {step.stats && <SQLBizOperationStats shape={shape} plan={step.stats} popup />}
    </div>,
    document.body
  );
}
