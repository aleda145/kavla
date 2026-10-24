import { Fragment, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownWideNarrow,
  ArrowRight,
  Columns3,
  Database,
  Ellipsis,
  FileQuestion,
  Filter,
  GitMerge,
  Layers,
  ListFilter,
  Sigma,
} from "lucide-react";
import { getSQLBizFlow, getSQLBizSummary } from "./sqlBizSummary";

const icons = {
  Read: Database,
  Join: GitMerge,
  Filter,
  Aggregate: Sigma,
  Select: Columns3,
  Sort: ArrowDownWideNarrow,
  Limit: ListFilter,
  Skip: ListFilter,
  Prepare: Layers,
  Window: Layers,
  Deduplicate: Layers,
  "Filter groups": Filter,
  "Filter window": Filter,
};

const colors: Record<keyof typeof icons, string> = {
  Read: "#dbeafe",
  Join: "#fed7aa",
  Filter: "#99f6e4",
  Aggregate: "#fbcfe8",
  Select: "#fef08a",
  Sort: "#bbf7d0",
  Limit: "#bae6fd",
  Skip: "#e7e5e4",
  Prepare: "#fde68a",
  Window: "#a5f3fc",
  Deduplicate: "#d9f99d",
  "Filter groups": "#99f6e4",
  "Filter window": "#99f6e4",
};

export function SQLBizBody({ text }: { text: string }) {
  const summary = getSQLBizSummary(text);
  const steps = getSQLBizFlow(summary);
  const tooltipId = useId();
  const container = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<{ index: number; rect: DOMRect } | null>(null);
  const activeStep = detail ? steps[detail.index] : undefined;

  useEffect(() => {
    setDetail(null);
  }, [text]);

  useEffect(() => {
    if (!detail) return;
    const dismiss = () => setDetail(null);
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target) &&
        !popover.current?.contains(event.target)
      )
        dismiss();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Node && !popover.current?.contains(event.target)) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [detail]);

  return (
    <div
      ref={container}
      aria-label="Query flow"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "12px 14px",
        gap: 12,
        background: "#fffef5",
      }}
    >
      {steps.length ? (
        <div
          role="list"
          aria-label="Query operations in order"
          style={{ display: "flex", alignItems: "flex-start", justifyContent: "center" }}
        >
          {steps.map((step, index) => {
            const Icon = icons[step.label as keyof typeof icons] ?? Ellipsis;
            const showDetail = (element: HTMLButtonElement) =>
              setDetail({ index, rect: element.getBoundingClientRect() });
            return (
              <Fragment key={index}>
                {index > 0 && (
                  <ArrowRight size={18} aria-hidden style={{ flexShrink: 0, marginTop: 15, color: "#a3a3a3" }} />
                )}
                <div role="listitem" style={{ flex: "1 1 0", minWidth: 0, maxWidth: 90 }}>
                  <button
                    type="button"
                    title={detail?.index === index ? undefined : `${step.label}\n${step.detail}`}
                    aria-label={`${step.label}: ${step.detail}`}
                    aria-describedby={detail?.index === index ? tooltipId : undefined}
                    onPointerDown={(event) => event.stopPropagation()}
                    onFocus={(event) => showDetail(event.currentTarget)}
                    onBlur={(event) => {
                      if (!popover.current?.contains(event.relatedTarget)) setDetail(null);
                    }}
                    onClick={(event) => showDetail(event.currentTarget)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Escape") setDetail(null);
                    }}
                    className="group rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: 0,
                      border: 0,
                      background: "none",
                      color: "#171717",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    <span
                      className="group-hover:-translate-y-0.5 transition-transform"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 46,
                        height: 46,
                        boxSizing: "border-box",
                        border: "2px solid #000",
                        borderRadius: 12,
                        background: colors[step.label as keyof typeof colors] ?? "#e5e7eb",
                      }}
                    >
                      <Icon size={23} strokeWidth={2} aria-hidden />
                    </span>
                    <span style={{ fontSize: 11, lineHeight: "14px", fontWeight: 800, textAlign: "center" }}>
                      {step.label}
                    </span>
                  </button>
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, color: "#737373" }}>
          <FileQuestion size={26} aria-hidden />
          <span style={{ fontSize: 12, fontWeight: 700 }}>{text.trim() ? "No overview yet" : "No query yet"}</span>
        </div>
      )}
      {summary.note && (
        <div title={summary.note} style={{ fontSize: 10, color: "#737373", textAlign: "center" }}>
          {steps.length ? "Partial overview · view SQL for full logic" : "Use the briefcase toggle to view SQL"}
        </div>
      )}
      {detail &&
        activeStep &&
        createPortal(
          <div
            ref={popover}
            id={tooltipId}
            role="tooltip"
            tabIndex={0}
            onBlur={(event) => {
              if (!container.current?.contains(event.relatedTarget)) setDetail(null);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setDetail(null);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              left: Math.max(12, Math.min(detail.rect.left + detail.rect.width / 2 - 140, window.innerWidth - 292)),
              top: Math.max(12, Math.min(detail.rect.bottom + 10, window.innerHeight - 232)),
              width: 280,
              maxHeight: 220,
              overflow: "auto",
              boxSizing: "border-box",
              padding: "10px 12px",
              border: "2px solid #000",
              borderRadius: 8,
              background: "#fff",
              boxShadow: "4px 4px 0 #000",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              lineHeight: "18px",
              color: "#171717",
              pointerEvents: "all",
              zIndex: 999999,
            }}
          >
            <strong>{activeStep.label}</strong>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{activeStep.detail}</div>
          </div>,
          document.body
        )}
    </div>
  );
}
