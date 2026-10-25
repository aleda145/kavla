import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
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
import { getSQLBizSummary, type BizOperation } from "./sqlBizSummary";

const operations: Record<BizOperation, { Icon: LucideIcon; color: string }> = {
  READ: { Icon: Database, color: "#dbeafe" },
  JOIN: { Icon: GitMerge, color: "#fed7aa" },
  FILTER: { Icon: Filter, color: "#99f6e4" },
  CALCULATE: { Icon: Calculator, color: "#fde68a" },
  BUCKET: { Icon: Blocks, color: "#ffedd5" },
  CLEAN: { Icon: Brush, color: "#ccfbf1" },
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

export function SQLBizBody({ text }: { text: string }) {
  const summary = getSQLBizSummary(text);
  const tooltipId = useId();
  const container = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<{ index: number; rect: DOMRect } | null>(null);
  const activeStep = detail ? summary.steps[detail.index] : undefined;

  useEffect(() => setDetail(null), [text]);
  useEffect(() => {
    if (!detail) return;
    const dismiss = () => setDetail(null);
    const outside = (event: Event) => {
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
            display: "flex",
            alignItems: "center",
            listStyle: "none",
            width: "max-content",
            margin: "auto 0",
            padding: 0,
            flexShrink: 0,
          }}
        >
          {summary.steps.map((step, index) => {
            const { Icon, color } = operations[step.label];
            const label = step.label === "CONDITIONAL" ? "CLASSIFY" : step.label;
            const card = step.card ?? { primary: step.detail };
            const previous = summary.steps[index - 1];
            const sameScope = previous?.scope === step.scope;
            const showDetail = (element: HTMLButtonElement) =>
              setDetail({ index, rect: element.getBoundingClientRect() });
            return (
              <li key={index} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                {index > 0 &&
                  (sameScope ? (
                    <ArrowRight size={14} aria-hidden style={{ margin: "0 4px", color: "#737373" }} />
                  ) : (
                    <span aria-hidden style={{ width: 22, textAlign: "center", color: "#a3a3a3" }}>
                      ·
                    </span>
                  ))}
                <button
                  type="button"
                  title={
                    detail?.index === index
                      ? undefined
                      : `${step.scope ? `${step.scope}\n` : ""}${label}\n${step.detail}`
                  }
                  aria-label={`${step.scope ? `${step.scope}: ` : ""}${label}: ${step.detail}`}
                  aria-describedby={detail?.index === index ? tooltipId : undefined}
                  onPointerDown={(event) => event.stopPropagation()}
                  onFocus={(event) => showDetail(event.currentTarget)}
                  onClick={(event) => showDetail(event.currentTarget)}
                  onBlur={(event) => {
                    if (!popover.current?.contains(event.relatedTarget)) setDetail(null);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape") setDetail(null);
                  }}
                  className="hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "stretch",
                    width: 132,
                    minHeight: 82,
                    padding: "9px 8px",
                    boxSizing: "border-box",
                    border: "2px solid #000",
                    borderRadius: 12,
                    background: color,
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
                    }}
                  >
                    <Icon size={13} strokeWidth={2} aria-hidden style={{ flexShrink: 0 }} />
                    {label}
                  </span>
                  <span
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 2,
                      overflow: "hidden",
                      overflowWrap: "anywhere",
                      fontSize: 12,
                      lineHeight: "16px",
                      fontWeight: 700,
                    }}
                  >
                    {card.primary}
                  </span>
                  {card.secondary && (
                    <span
                      style={{
                        fontSize: 10,
                        lineHeight: "14px",
                        color: "#444",
                        marginTop: 3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {card.secondary}
                    </span>
                  )}
                </button>
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
              if (!container.current?.contains(event.relatedTarget)) setDetail(null);
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
              {activeStep.detail}
            </pre>
          </div>,
          document.body
        )}
    </div>
  );
}
