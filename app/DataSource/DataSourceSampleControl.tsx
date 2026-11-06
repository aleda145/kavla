import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { type Editor, useValue } from "tldraw";
import type { DataSourceShape } from "./data-source-types";

export function DataSourceSampleControl({
  editor,
  shape,
  onClose,
}: {
  editor: Editor;
  shape: DataSourceShape;
  onClose: () => void;
}) {
  const percent = shape.props.samplePercent ?? 100;
  const [draft, setDraft] = useState(String(percent));
  const disabled = useValue("Source sampling readonly", () => editor.getInstanceState().isReadonly || shape.isLocked, [
    editor,
    shape.isLocked,
  ]);
  useEffect(() => setDraft(String(percent)), [percent]);
  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(value) && value >= 0.01 && value <= 100;
  const apply = (samplePercent: number) => {
    if (disabled) return;
    editor.updateShape<DataSourceShape>({ id: shape.id, type: "data-source", props: { samplePercent } });
    onClose();
  };

  return (
    <form
      className="mx-3 mb-3 shrink-0 rounded border-2 border-black bg-yellow-50 p-2 text-xs"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) apply(value);
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-2 font-bold">
        <span>Downstream sample</span>
        <button
          type="button"
          title="Close sampling"
          aria-label="Close sampling"
          onClick={onClose}
          className="cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {[1, 10, 25, 100].map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={disabled}
            aria-pressed={percent === preset}
            onClick={() => apply(preset)}
            className="cursor-pointer rounded border-2 border-black bg-white px-2 py-1 font-bold aria-pressed:bg-yellow-300 disabled:opacity-50"
          >
            {preset === 100 ? "All rows" : `${preset}%`}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          aria-label="Percentage of source data exposed downstream"
          aria-invalid={!valid}
          min={0.01}
          max={100}
          step="any"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          className="min-w-0 flex-1 rounded border-2 border-black bg-white px-2 py-1"
        />
        <span>%</span>
        <button
          type="submit"
          disabled={!valid || disabled}
          aria-label="Apply sample percentage"
          title="Apply sample percentage"
          className="flex cursor-pointer items-center gap-1 rounded border-2 border-black bg-yellow-300 px-2 py-1 font-bold disabled:opacity-50"
        >
          <Check size={14} />
          <span className="kavla-control-label">Apply</span>
        </button>
      </div>
      {!valid && (
        <p role="alert" className="mt-1 text-red-700">
          Enter a percentage from 0.01 to 100.
        </p>
      )}
      <p className="mt-2">
        Samples blocks of rows. The amount is approximate and can change each run, or be empty for small tables. Rerun
        downstream queries after applying.
      </p>
    </form>
  );
}
