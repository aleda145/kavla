import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette } from "lucide-react";
import { type Editor, useValue } from "tldraw";
import type { DataSourceShape } from "./data-source-types";
import "./data-source-sample.css";

export function DataSourceSampleControl({ editor, shape }: { editor: Editor; shape: DataSourceShape }) {
  const percent = shape.props.samplePercent ?? 100;
  const [open, setOpen] = useState(false);
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const tooltipId = useId();
  const disabled = useValue(
    "Source sampling readonly",
    () => editor.getInstanceState().isReadonly || shape.isLocked || shape.props.isRunning,
    [editor, shape.isLocked, shape.props.isRunning]
  );
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

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
          {[0.1, 1, 10, 100].map((preset) => (
            <button
              key={preset}
              type="button"
              className="kavla-source-sample-preset"
              aria-pressed={percent === preset}
              disabled={disabled}
              onClick={() => update(preset)}
            >
              {preset}%
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
