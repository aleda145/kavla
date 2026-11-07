import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Pipette } from "lucide-react";
import { type Editor, useToasts, useValue } from "tldraw";
import type { DataSourceShape } from "./data-source-types";
import { SourceSampleEstimate } from "./SourceSampleEstimate";
import { useData } from "../client/useLocalServer";
import { getSampleRowCount, loadSampleRowCount } from "./sample-row-count";
import "./data-source-sample.css";

export function DataSourceSampleControl({ editor, shape }: { editor: Editor; shape: DataSourceShape }) {
  const percent = shape.props.samplePercent ?? 100;
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingPercent, setPendingPercent] = useState<number | null>(null);
  const pending = useRef(false);
  const { runRemoteQuery } = useData();
  const countLoading = useValue(
    "Sample configuration loading",
    () => percent < 100 && getSampleRowCount(editor, shape)?.status === "loading",
    [editor, shape, percent]
  );
  const busy = pendingPercent !== null || countLoading;
  const { addToast } = useToasts();
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const [presetHover, setPresetHover] = useState<{ percent: number; rect: DOMRect } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const tooltipId = useId();
  const disabled = useValue(
    "Source sampling readonly",
    () => editor.getInstanceState().isReadonly || shape.isLocked || shape.props.isRunning,
    [editor, shape.isLocked, shape.props.isRunning]
  );
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const closePanel = () => {
    cancelClose();
    pinned.current = false;
    setOpen(false);
    setPresetHover(null);
  };
  const pinPanel = () => {
    cancelClose();
    pinned.current = true;
    setTooltipRect(null);
    setOpen(true);
  };
  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closePanel();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const update = async (samplePercent: number) => {
    if (disabled || pending.current || getSampleRowCount(editor, shape)?.status === "loading") return;
    pinPanel();
    pending.current = true;
    setPresetHover(null);
    setPendingPercent(samplePercent);
    try {
      if (!shape.props.remoteTableRef) throw new Error("The data source is unavailable.");
      editor.updateShape<DataSourceShape>({ id: shape.id, type: "data-source", props: { samplePercent } });
      const current = editor.getShape<DataSourceShape>(shape.id);
      if (
        !current ||
        current.props.remoteTableRef !== shape.props.remoteTableRef ||
        (current.props.samplePercent ?? 100) !== samplePercent
      ) {
        throw new Error("The data source changed while configuring the sample.");
      }
      if (samplePercent < 100) await loadSampleRowCount(editor, current, runRemoteQuery, true);
    } catch (error) {
      addToast({
        title: "Sample failed",
        description: error instanceof Error ? error.message : String(error),
        severity: "error",
      });
    } finally {
      pending.current = false;
      setPendingPercent(null);
    }
  };

  return (
    <div
      ref={rootRef}
      className="kavla-source-sample"
      onMouseEnter={() => {
        cancelClose();
        if (disabled || busy) return;
        setTooltipRect(null);
        setOpen(true);
      }}
      onMouseLeave={() => {
        cancelClose();
        if (!pinned.current) closeTimer.current = setTimeout(closePanel, 200);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          closePanel();
          buttonRef.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closePanel();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="kavla-source-sample-tab"
        aria-label={busy ? `Preparing ${pendingPercent ?? percent}% sample` : `Sample: ${percent}%`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={tooltipRect && !open ? tooltipId : undefined}
        data-sampling={percent < 100}
        disabled={disabled || busy}
        aria-busy={busy}
        onFocus={(event) => setTooltipRect(event.currentTarget.getBoundingClientRect())}
        onBlur={() => setTooltipRect(null)}
        onClick={pinPanel}
      >
        {busy ? (
          <Loader2 size={18} className="animate-spin" aria-label="Preparing sample" />
        ) : (
          <Pipette size={18} aria-hidden />
        )}
        {percent < 100 && <span>{percent}%</span>}
      </button>
      {tooltipRect &&
        !open &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="kavla-source-sample-tooltip"
            style={{ left: tooltipRect.left + tooltipRect.width / 2, top: tooltipRect.top - 12 }}
          >
            Sample
          </div>,
          document.body
        )}
      {open && (
        <div id={panelId} className="kavla-source-sample-panel" role="group" aria-labelledby={`${panelId}-title`}>
          <div id={`${panelId}-title`} className="kavla-source-sample-title">
            Set Sampling percentage
          </div>
          {[0.1, 1, 10, 100].map((preset) => (
            <button
              key={preset}
              type="button"
              className="kavla-source-sample-preset"
              aria-pressed={percent === preset}
              disabled={disabled || busy}
              aria-busy={busy && (pendingPercent ?? percent) === preset}
              aria-describedby={presetHover?.percent === preset ? `${tooltipId}-estimate` : undefined}
              onMouseEnter={(event) => {
                if (preset < 100 && shape.props.sourceType === "bigquery") {
                  setPresetHover({ percent: preset, rect: event.currentTarget.getBoundingClientRect() });
                }
              }}
              onMouseLeave={() => setPresetHover(null)}
              onFocus={(event) => {
                if (preset < 100 && shape.props.sourceType === "bigquery") {
                  setPresetHover({ percent: preset, rect: event.currentTarget.getBoundingClientRect() });
                }
              }}
              onBlur={() => setPresetHover(null)}
              onClick={() => void update(preset)}
            >
              {preset}%
            </button>
          ))}
        </div>
      )}
      {open &&
        presetHover &&
        shape.props.remoteTableRef &&
        createPortal(
          <div
            id={`${tooltipId}-estimate`}
            role="tooltip"
            className="kavla-source-sample-tooltip"
            style={{ left: presetHover.rect.left + presetHover.rect.width / 2, top: presetHover.rect.top - 12 }}
          >
            <SourceSampleEstimate tableRef={shape.props.remoteTableRef} percent={presetHover.percent} />
          </div>,
          document.body
        )}
    </div>
  );
}
