import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette } from "lucide-react";
import { type Editor, useValue } from "tldraw";
import type { DataSourceShape } from "./data-source-types";
import "../Knob/knob.css";
import "./data-source-sample.css";

export function DataSourceSampleControl({ editor, shape }: { editor: Editor; shape: DataSourceShape }) {
  const percent = shape.props.samplePercent ?? 100;
  const [open, setOpen] = useState(false);
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState(String(percent));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const tooltipId = useId();
  const disabled = useValue(
    "Source sampling readonly",
    () => editor.getInstanceState().isReadonly || shape.isLocked || shape.props.isRunning,
    [editor, shape.isLocked, shape.props.isRunning]
  );
  useEffect(() => setDraft(String(percent)), [percent]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 100;
  const update = (samplePercent: number) => {
    if (disabled) return;
    editor.updateShape<DataSourceShape>({ id: shape.id, type: "data-source", props: { samplePercent } });
  };

  return (
    <div
      ref={rootRef}
      className="kavla-source-sample"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="kavla-source-sample-tab"
        aria-label={`Sample: ${percent}%`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={tooltipRect && !open ? tooltipId : undefined}
        data-sampling={percent < 100}
        disabled={disabled}
        onMouseEnter={(event) => setTooltipRect(event.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setTooltipRect(null)}
        onFocus={(event) => setTooltipRect(event.currentTarget.getBoundingClientRect())}
        onBlur={() => setTooltipRect(null)}
        onClick={() => {
          setTooltipRect(null);
          setOpen((current) => !current);
        }}
      >
        <Pipette size={18} aria-hidden />
        <span>{percent}%</span>
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
        <div id={panelId} className="kavla-source-sample-panel" role="group" aria-label="Sample percentage">
          <div className="kavla-source-sample-value">
            <input
              type="number"
              className="kavla-knob-input"
              aria-label="Sample percentage"
              aria-invalid={!valid}
              min={0}
              max={100}
              step="any"
              value={draft}
              disabled={disabled}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                const next = event.currentTarget.valueAsNumber;
                if (Number.isFinite(next) && next >= 0 && next <= 100) update(next);
              }}
              onBlur={() => setDraft(String(percent))}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span>%</span>
          </div>
          <input
            type="range"
            className="kavla-knob-slider"
            aria-label="Sample percentage"
            aria-valuetext={`${percent}%`}
            min={0}
            max={100}
            step={0.1}
            value={percent}
            disabled={disabled}
            onChange={(event) => update(event.currentTarget.valueAsNumber)}
          />
          <div className="kavla-knob-range" aria-hidden>
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>
      )}
    </div>
  );
}
