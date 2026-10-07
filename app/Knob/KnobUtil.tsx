import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  Loader2,
  Settings2,
  SlidersHorizontal,
  List,
  ToggleLeft,
} from "lucide-react";
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  T,
  resizeBox,
  useValue,
  type Editor,
  type RecordProps,
  type TLResizeInfo,
} from "tldraw";
import EditableText from "../util/EditableText";
import { getColumnTypeColor } from "../util/column-colors";
import { getUniqueKnobName } from "./createKnobs";
import type { KnobShape, KnobTemporalType } from "./knob-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import { mapKnobParameters } from "./knobSQL";
import { getKnobUpstreamSources, isKnobQueryConnected } from "./knobUpstream";
import { getColumnAnalysisType } from "../src/duckdb/column-stats-sql";
import {
  formatKnobTime,
  getTimeStep,
  timeSteps,
  timeSliderSteps,
  timeSliderValue,
  timeSliderPosition,
} from "./knobTime";
import { TimeInput } from "./TimeInput";
import "./knob.css";

const compactHeight = 126;

function NumberInput({
  value,
  label,
  step = "any",
  disabled,
  growToContent = false,
  onChange,
}: {
  value: number;
  label: string;
  step?: number | "any";
  disabled: boolean;
  growToContent?: boolean;
  onChange: (value: number) => boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);
  return (
    <input
      className={`kavla-knob-input${growToContent ? " kavla-knob-current-value" : ""}`}
      style={growToContent ? { width: `min(100%, max(34%, ${Math.max(8, draft.length + 4)}ch))` } : undefined}
      type="number"
      aria-label={label}
      aria-invalid={invalid}
      value={draft}
      step={step}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        const next = event.currentTarget.valueAsNumber;
        if (!Number.isFinite(next)) {
          setInvalid(true);
          return;
        }
        setInvalid(!onChange(next));
      }}
      onBlur={() => {
        setDraft(String(value));
        setInvalid(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function ChoicesInput({
  options,
  disabled,
  onChange,
}: {
  options: string[];
  disabled: boolean;
  onChange: (options: string[]) => void;
}) {
  const [draft, setDraft] = useState(options.join("\n"));
  const saved = options.join("\n");
  useEffect(() => {
    setDraft(saved);
  }, [saved]);
  return (
    <textarea
      className="kavla-knob-input kavla-knob-choices"
      aria-label="Choices, one per line"
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setDraft(text);
        onChange(text.length ? [...new Set(text.split("\n"))] : []);
      }}
      onBlur={() => setDraft(saved)}
    />
  );
}

function Knob({ shape, editor }: { shape: KnobShape; editor: Editor }) {
  const { name, value, min, max, step, h } = shape.props;
  const stackRangeOptions = useMemo(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return true;
    context.font = "700 12px Inter";
    const widestNumber = Math.max(...[min, max, step].map((number) => context.measureText(String(number)).width));
    // Shape border, options padding, grid gaps, and input padding/border all take space.
    return (shape.props.w - 48) / 3 < widestNumber + 20;
  }, [min, max, step, shape.props.w]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openTimePicker, setOpenTimePicker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsHeight = useRef(0);
  const disabled = useValue("Knob readonly", () => editor.getInstanceState().isReadonly || shape.isLocked, [
    editor,
    shape.isLocked,
  ]);
  const boolean =
    shape.props.kind === "boolean" || (shape.props.kind === "category" && shape.props.categoryType === "boolean");
  const categorical = shape.props.kind === "category" && !boolean;
  const temporal = shape.props.kind === "timestamp";
  const columnOptions = useValue(
    "Connected knob columns",
    () => {
      if (boolean) return [];
      const current = editor.getShape<KnobShape>(shape.id);
      if (!current) return [];
      const queries = editor
        .getCurrentPageShapes()
        .filter(
          (candidate): candidate is SQLTextAreaShape =>
            candidate.type === "sql-text-area" && isKnobQueryConnected(current, candidate as SQLTextAreaShape)
        );
      return getKnobUpstreamSources(editor, queries).flatMap(({ query, source }) => {
        const columns = source.type === "data-source" ? source.props.metadata : source.props.outputSchema;
        return (columns ?? [])
          .filter((column) => {
            const type = getColumnAnalysisType(column.type);
            if (categorical)
              return !/BOOL/i.test(column.type) && (type === "text" || /^(ENUM|UUID)/i.test(column.type));
            if (temporal) return type === "temporal" && /DATE|TIMESTAMP/i.test(column.type);
            return type === "numeric";
          })
          .map((column) => ({
            queryId: query.id,
            sourceId: source.id,
            column: column.name,
            value: JSON.stringify([source.id, column.name]),
            label: column.name,
          }));
      });
    },
    [editor, shape.id, boolean, categorical, temporal]
  );
  const selectedColumn =
    shape.props.inferFromColumn !== false && shape.props.inferenceColumn
      ? JSON.stringify([
          shape.props.inferenceSourceId ??
            columnOptions.find(
              (option) =>
                option.queryId === shape.props.inferenceQueryId && option.column === shape.props.inferenceColumn
            )?.sourceId,
          shape.props.inferenceColumn,
        ])
      : "";
  const temporalType = shape.props.temporalType ?? "timestamp";
  const timeLabel = temporalType === "date" ? "Date" : "Date & time";
  const timeStep = Math.max(temporalType === "date" ? 86_400_000 : 1000, step);
  const pickerProps = (field: string) => {
    const pickerId = `${shape.id}:${field}`;
    return {
      pickerId,
      open: openTimePicker === pickerId,
      onOpenChange: (open: boolean) => setOpenTimePicker(open ? pickerId : null),
      editor,
    };
  };
  const loading = shape.props.inferenceStatus === "loading";
  const options = shape.props.options ?? [];
  const update = (props: Partial<KnobShape["props"]>) => {
    if (!disabled) editor.updateShape<KnobShape>({ id: shape.id, type: "knob", props });
  };
  const updateSettings = (props: Partial<KnobShape["props"]>) => {
    setError(null);
    update({
      ...props,
      inferFromColumn: false,
      inferenceColumn: undefined,
      inferenceSourceId: undefined,
      inferenceStatus: "ready",
      inferenceError: null,
    });
  };
  const rename = (nextName: string) => {
    if (disabled || nextName === name) return;
    editor.run(() => {
      for (const query of editor.getCurrentPageShapes()) {
        if (query.type !== "sql-text-area") continue;
        const sqlQuery = query as SQLTextAreaShape;
        const text = mapKnobParameters(
          sqlQuery.props.text,
          (parameter) => `{${parameter.toUpperCase() === name.toUpperCase() ? nextName : parameter}}`
        );
        if (text !== sqlQuery.props.text)
          editor.updateShape<SQLTextAreaShape>({ id: query.id, type: "sql-text-area", props: { text, isDirty: true } });
      }
      update({ name: nextName });
    });
  };
  const setValue = (next: number) => {
    if (!Number.isFinite(next) || disabled) return false;
    update({ value: Math.max(min, Math.min(max, next)) });
    return true;
  };
  const setTimeValue = (next: number) => {
    if (!Number.isFinite(next) || disabled) return false;
    if (next < min || next > max) updateSettings({ value: next, min: Math.min(min, next), max: Math.max(max, next) });
    else update({ value: next });
    return true;
  };
  const changeRange = (field: "min" | "max" | "step", next: number) => {
    const range = { min, max, step, [field]: next };
    if (temporal && range.min > range.max) {
      if (field === "min") range.max = next;
      if (field === "max") range.min = next;
    }
    if (range.min > range.max || range.step <= 0 || !Number.isFinite(range.max - range.min)) {
      setError(range.step <= 0 ? "Step must be positive." : "Min must not exceed max; the range must be finite.");
      return false;
    }
    updateSettings({ ...range, value: Math.max(range.min, Math.min(range.max, value)) });
    return true;
  };
  const changeChoices = (nextOptions: string[]) => {
    if (!nextOptions.length) {
      setError("Add at least one choice.");
      return;
    }
    updateSettings({
      options: nextOptions,
      optionsTruncated: false,
      categoryType: "text",
      categoryValue:
        shape.props.categoryValue !== undefined && nextOptions.includes(shape.props.categoryValue)
          ? shape.props.categoryValue
          : nextOptions[0],
    });
  };
  const changeKind = (kind: "numeric" | "category" | "timestamp" | "boolean") => {
    if (kind === (boolean ? "boolean" : (shape.props.kind ?? "numeric"))) return;
    if (kind === "boolean") {
      updateSettings({
        kind,
        categoryType: "boolean",
        categoryValue: shape.props.categoryValue === "false" ? "false" : "true",
        options: ["false", "true"],
        optionsTruncated: false,
      });
    } else if (kind === "timestamp") {
      const end = Math.floor(Date.now() / 60_000) * 60_000;
      const start = end - 30 * 86_400_000;
      updateSettings({
        kind,
        temporalType: "timestamp",
        min: start,
        max: end,
        value: start,
        step: getTimeStep(start, end, "timestamp"),
      });
    } else if (kind === "numeric") updateSettings(temporal ? { kind, min: 0, max: 100, value: 10, step: 1 } : { kind });
    else {
      const nextOptions = options.length ? options : [String(value)];
      updateSettings({
        kind,
        options: nextOptions,
        categoryType: "text",
        categoryValue:
          shape.props.categoryValue !== undefined && nextOptions.includes(shape.props.categoryValue)
            ? shape.props.categoryValue
            : nextOptions[0],
      });
    }
  };
  const changeTimeType = (type: KnobTemporalType) => {
    const round = (number: number) => (type === "date" ? Math.floor(number / 86_400_000) * 86_400_000 : number);
    updateSettings({
      temporalType: type,
      min: round(min),
      max: round(max),
      value: round(value),
      step: type === "date" ? Math.max(86_400_000, Math.round(step / 86_400_000) * 86_400_000) : step,
    });
  };
  const timeRangeLabel = (number: number) => {
    const text = formatKnobTime(number, temporalType);
    return temporalType !== "date" && formatKnobTime(min, "date") === formatKnobTime(max, "date")
      ? text.slice(11)
      : text.slice(0, 10);
  };

  useLayoutEffect(() => {
    const resize = () => {
      const height = settingsRef.current?.offsetHeight ?? 0;
      const current = editor.getShape<KnobShape>(shape.id);
      if (!current) return;
      const collapsedHeight = Math.max(
        current.props.kind === "timestamp" ? 126 : 96,
        current.props.h - settingsHeight.current
      );
      if (height === settingsHeight.current && current.props.h === collapsedHeight + height) return;
      settingsHeight.current = height;
      editor.updateShape<KnobShape>({ id: shape.id, type: "knob", props: { h: collapsedHeight + height } });
    };
    resize();
    if (!settingsRef.current) return;
    const observer = new ResizeObserver(resize);
    observer.observe(settingsRef.current);
    return () => observer.disconnect();
  }, [editor, shape.id, shape.props.kind, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen && !openTimePicker) return;
    const isResizingKnob = () =>
      editor.getSelectedShapeIds().includes(shape.id) &&
      (editor.isIn("select.resizing") || editor.isIn("select.pointing_resize_handle"));
    const closePickerOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        target instanceof Element &&
        target.closest("[data-knob-time-input]")?.getAttribute("data-knob-time-input") === openTimePicker
      )
        return;
      setOpenTimePicker(null);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isResizingKnob()) return;
      event.stopPropagation();
      event.preventDefault();
      if (openTimePicker) {
        setOpenTimePicker(null);
      }
    };
    if (openTimePicker) document.addEventListener("pointerdown", closePickerOutside, true);
    document.addEventListener("keydown", closeWithEscape, true);
    return () => {
      if (openTimePicker) document.removeEventListener("pointerdown", closePickerOutside, true);
      document.removeEventListener("keydown", closeWithEscape, true);
    };
  }, [editor, shape.id, settingsOpen, openTimePicker]);

  const controlStyle = {
    "--knob-control-height": `${Math.min(48, Math.max(28, (h - settingsHeight.current - 50) / 2))}px`,
  } as CSSProperties;
  return (
    <HTMLContainer className="kavla-knob" style={controlStyle}>
      <div className="kavla-knob-header">
        <div
          className="kavla-knob-name"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("input, button")) event.stopPropagation();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {disabled ? (
            <strong>{name}</strong>
          ) : (
            <EditableText text={name} onSave={rename} editor={editor} shapeId={shape.id} />
          )}
        </div>
        {loading && <Loader2 className="animate-spin" size={14} aria-label="Finding column values" />}
        {!loading && shape.props.inferenceError && (
          <span title={shape.props.inferenceError}>
            <AlertCircle size={14} aria-label={shape.props.inferenceError} />
          </span>
        )}
        <button
          ref={buttonRef}
          className="kavla-knob-settings-button"
          type="button"
          aria-label="Knob options"
          title="Knob options"
          aria-expanded={settingsOpen}
          disabled={disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setError(null);
            setSettingsOpen((open) => !open);
          }}
        >
          <Settings2 size={14} />
          <span>Options</span>
        </button>
      </div>
      <div
        className="kavla-knob-body"
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {boolean ? (
          <button
            type="button"
            className="kavla-knob-toggle"
            role="switch"
            aria-label={`${name} value`}
            aria-checked={shape.props.categoryValue === "true"}
            disabled={disabled || loading}
            onClick={() => update({ categoryValue: shape.props.categoryValue === "true" ? "false" : "true" })}
          >
            <span className={`kavla-knob-toggle-track ${getColumnTypeColor("BOOLEAN")}`} aria-hidden="true">
              <span />
            </span>
            <span>{shape.props.categoryValue === "true" ? "On" : "Off"}</span>
          </button>
        ) : categorical ? (
          <div className="kavla-knob-select">
            <select
              className="kavla-knob-input"
              aria-label={`${name} value`}
              value={shape.props.categoryValue ?? ""}
              disabled={disabled || loading || !options.length}
              onChange={(event) => update({ categoryValue: event.currentTarget.value })}
            >
              {shape.props.categoryValue !== undefined && !options.includes(shape.props.categoryValue) && (
                <option value={shape.props.categoryValue}>{shape.props.categoryValue || "(empty)"}</option>
              )}
              {options.map((option) => (
                <option key={option} value={option}>
                  {option || "(empty)"}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        ) : temporal ? (
          <>
            <div className="kavla-knob-time-value kavla-knob-current-time-value">
              <TimeInput
                {...pickerProps("value")}
                label={`${name} ${timeLabel}`}
                value={value}
                type={temporalType}
                disabled={disabled || loading}
                onChange={setTimeValue}
                growToContent
              />
            </div>
            <input
              className="kavla-knob-slider kavla-knob-time-slider"
              type="range"
              aria-label={`${name} slider`}
              aria-valuetext={formatKnobTime(value, temporalType)}
              min={0}
              max={timeSliderSteps(min, max, timeStep)}
              step={1}
              value={timeSliderPosition(min, max, timeStep, value)}
              disabled={disabled || loading || min === max}
              onChange={(event) => setValue(timeSliderValue(min, max, timeStep, event.currentTarget.valueAsNumber))}
            />
            <div className="kavla-knob-range">
              <span title={formatKnobTime(min, temporalType)}>{timeRangeLabel(min)}</span>
              <span title={formatKnobTime(max, temporalType)}>{timeRangeLabel(max)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="kavla-knob-number-control">
              <NumberInput
                label={`${name} value`}
                value={value}
                step={step}
                disabled={disabled || loading}
                growToContent
                onChange={setValue}
              />
              <input
                className="kavla-knob-slider"
                type="range"
                aria-label={`${name} slider`}
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled || loading || min === max}
                onChange={(event) => setValue(event.currentTarget.valueAsNumber)}
              />
            </div>
            <div className="kavla-knob-range">
              <span>{min}</span>
              <span>{max}</span>
            </div>
          </>
        )}
      </div>
      {settingsOpen && (
        <div
          ref={settingsRef}
          className="kavla-knob-options"
          role="group"
          aria-label={`${name} options`}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div className="kavla-knob-option-label">Control</div>
          <div className="kavla-knob-kind">
            <button
              type="button"
              aria-pressed={!categorical && !temporal && !boolean}
              className={!categorical && !temporal && !boolean ? getColumnTypeColor("DOUBLE") : undefined}
              disabled={disabled}
              onClick={() => changeKind("numeric")}
            >
              <SlidersHorizontal size={15} /> Number
            </button>
            <button
              type="button"
              aria-pressed={categorical}
              className={categorical ? getColumnTypeColor("TEXT") : undefined}
              disabled={disabled}
              onClick={() => changeKind("category")}
            >
              <List size={15} /> Category
            </button>
            <button
              type="button"
              aria-pressed={temporal}
              className={temporal ? getColumnTypeColor("TIMESTAMP") : undefined}
              disabled={disabled}
              onClick={() => changeKind("timestamp")}
            >
              <CalendarClock size={15} /> Timestamp
            </button>
            <button
              type="button"
              aria-pressed={boolean}
              className={boolean ? getColumnTypeColor("BOOLEAN") : undefined}
              disabled={disabled}
              onClick={() => changeKind("boolean")}
            >
              <ToggleLeft size={15} /> Boolean
            </button>
          </div>
          {!boolean && (
            <label className="kavla-knob-option-label">
              Values from column
              <select
                className="kavla-knob-input"
                aria-label="Values from column"
                value={selectedColumn || (shape.props.inferFromColumn !== false ? "automatic" : "")}
                disabled={disabled}
                onChange={(event) => {
                  if (event.currentTarget.value === "") {
                    updateSettings({});
                    return;
                  }
                  const column = columnOptions.find((option) => option.value === event.currentTarget.value);
                  if (!column) return;
                  setError(null);
                  update({
                    inferenceQueryId: column.queryId,
                    inferenceSourceId: column.sourceId,
                    inferenceColumn: column.column,
                    inferFromColumn: true,
                    inferenceStatus: "loading",
                    inferenceError: null,
                  });
                  window.dispatchEvent(new CustomEvent("kavla:infer-knob", { detail: { shapeId: shape.id } }));
                }}
              >
                <option value="">Manual</option>
                {!selectedColumn && shape.props.inferFromColumn !== false && (
                  <option value="automatic" disabled>
                    Automatic
                  </option>
                )}
                {selectedColumn && !columnOptions.some((option) => option.value === selectedColumn) && (
                  <option value={selectedColumn} disabled>
                    {shape.props.inferenceColumn} (unavailable)
                  </option>
                )}
                {columnOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {categorical ? (
            <label className="kavla-knob-option-label">
              Choices <span className="kavla-knob-option-unit">one per line</span>
              <ChoicesInput options={options} disabled={disabled} onChange={changeChoices} />
            </label>
          ) : temporal ? (
            <>
              <label className="kavla-knob-option-label">
                Format
                <select
                  className="kavla-knob-input"
                  value={temporalType === "date" ? "date" : "timestamp"}
                  disabled={disabled}
                  onChange={(event) =>
                    changeTimeType(
                      event.currentTarget.value === "date"
                        ? "date"
                        : temporalType === "timestamptz"
                          ? "timestamptz"
                          : "timestamp"
                    )
                  }
                >
                  <option value="date">Date</option>
                  <option value="timestamp">Date & time</option>
                </select>
              </label>
              {(["min", "max"] as const).map((field) => (
                <div key={field} className="kavla-knob-option-label">
                  {field === "min" ? "Start" : "End"}
                  <TimeInput
                    {...pickerProps(field)}
                    label={`${field === "min" ? "Start" : "End"} ${timeLabel}`}
                    value={shape.props[field]}
                    type={temporalType}
                    disabled={disabled}
                    onChange={(next) => changeRange(field, next)}
                  />
                </div>
              ))}
              <label className="kavla-knob-option-label">
                Step
                <select
                  className="kavla-knob-input"
                  value={timeStep}
                  disabled={disabled}
                  onChange={(event) => changeRange("step", Number(event.currentTarget.value))}
                >
                  {!timeSteps.some((option) => option.value === timeStep) && (
                    <option value={timeStep}>{timeStep / 1000} seconds</option>
                  )}
                  {timeSteps
                    .filter((option) => temporalType !== "date" || option.value >= 86_400_000)
                    .map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                </select>
              </label>
            </>
          ) : !boolean ? (
            <div className={`kavla-knob-range-options${stackRangeOptions ? " kavla-knob-range-options-stacked" : ""}`}>
              {(["min", "max", "step"] as const).map((field) => (
                <label key={field} className="kavla-knob-option-label">
                  {field}
                  <NumberInput
                    label={`Knob ${field}`}
                    value={shape.props[field]}
                    disabled={disabled}
                    onChange={(next) => changeRange(field, next)}
                  />
                </label>
              ))}
            </div>
          ) : null}
          {shape.props.optionsTruncated && categorical && (
            <div className="kavla-knob-option-unit">First 200 choices</div>
          )}
          {(error || (shape.props.inferenceColumn && shape.props.inferenceError)) && (
            <div className="kavla-knob-error" role="alert">
              {error ?? shape.props.inferenceError}
            </div>
          )}
        </div>
      )}
    </HTMLContainer>
  );
}

export class KnobUtil extends ShapeUtil<KnobShape> {
  static override type = "knob" as const;
  static override props: RecordProps<KnobShape> = {
    w: T.number,
    h: T.number,
    name: T.string,
    value: T.number,
    min: T.number,
    max: T.number,
    step: T.number,
    downstreamShapeIds: T.arrayOf(T.string).nullable(),
    upstreamShapeIds: T.arrayOf(T.string).nullable(),
    kind: T.literalEnum("numeric", "category", "timestamp", "boolean").optional(),
    temporalType: T.literalEnum("date", "timestamp", "timestamptz").optional(),
    categoryType: T.literalEnum("text", "boolean").optional(),
    categoryValue: T.string.optional(),
    options: T.arrayOf(T.string).optional(),
    optionsTruncated: T.boolean.optional(),
    inferFromColumn: T.boolean.optional(),
    inferenceQueryId: T.string.optional(),
    inferenceColumn: T.string.optional(),
    inferenceSourceId: T.string.optional(),
    inferenceStatus: T.literalEnum("loading", "ready", "error").optional(),
    inferenceError: T.string.nullable().optional(),
  };
  override canResize() {
    return true;
  }
  override onResize(shape: KnobShape, info: TLResizeInfo<KnobShape>) {
    return resizeBox(shape, info, { minWidth: 160, minHeight: shape.props.kind === "timestamp" ? 126 : 96 });
  }
  getDefaultProps(): KnobShape["props"] {
    return {
      w: 240,
      h: compactHeight,
      name: getUniqueKnobName(this.editor, "knob"),
      value: 10,
      min: 0,
      max: 100,
      step: 1,
      inferFromColumn: true,
      downstreamShapeIds: [],
      upstreamShapeIds: [],
    };
  }
  getGeometry(shape: KnobShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }
  component(shape: KnobShape) {
    return <Knob shape={shape} editor={this.editor} />;
  }
  indicator(shape: KnobShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={12} ry={12} />;
  }
}
