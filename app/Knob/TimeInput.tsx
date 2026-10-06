import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useValue, type Editor } from "tldraw";
import type { KnobTemporalType } from "./knob-types";
import { formatKnobTime, parseKnobTime } from "./knobTime";

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function TimeInput({
  value,
  label,
  type,
  disabled,
  onChange,
  pickerId,
  open,
  onOpenChange,
  editor,
}: {
  value: number;
  label: string;
  type: KnobTemporalType;
  disabled: boolean;
  onChange: (value: number) => boolean;
  pickerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editor: Editor;
}) {
  const saved = formatKnobTime(value, type);
  const [draft, setDraft] = useState(saved);
  const [timeDraft, setTimeDraft] = useState(saved.slice(11));
  const [invalid, setInvalid] = useState(false);
  const [month, setMonth] = useState(() => ({
    year: new Date(value).getUTCFullYear(),
    index: new Date(value).getUTCMonth(),
  }));
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const camera = useValue("Knob date picker camera", () => editor.getCamera(), [editor]);

  useEffect(() => {
    setDraft(saved);
    setTimeDraft(saved.slice(11));
    setInvalid(false);
  }, [saved]);
  useEffect(() => {
    if (open) setMonth({ year: new Date(value).getUTCFullYear(), index: new Date(value).getUTCMonth() });
  }, [open, value]);
  useLayoutEffect(() => {
    if (!open) return;
    const positionPicker = () => {
      if (!anchorRef.current || !pickerRef.current) return;
      const anchor = anchorRef.current.getBoundingClientRect();
      const picker = pickerRef.current.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - picker.width - 8)),
        top: Math.max(
          8,
          anchor.bottom + 6 + picker.height <= window.innerHeight - 8
            ? anchor.bottom + 6
            : anchor.top - picker.height - 6
        ),
      });
    };
    positionPicker();
    window.addEventListener("resize", positionPicker);
    window.addEventListener("scroll", positionPicker, true);
    return () => {
      window.removeEventListener("resize", positionPicker);
      window.removeEventListener("scroll", positionPicker, true);
    };
  }, [open, camera, month.year, month.index]);

  const applyText = (text: string) => {
    const pattern = type === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!pattern.test(text)) return false;
    let next: number;
    try {
      next = parseKnobTime(text);
    } catch {
      return false;
    }
    if (formatKnobTime(next, type) !== text) return false;
    return onChange(next);
  };
  const first = new Date(0);
  first.setUTCFullYear(month.year, month.index, 1);
  const dayOffset = (first.getUTCDay() + 6) % 7;
  const last = new Date(first);
  last.setUTCMonth(month.index + 1, 0);
  const moveMonth = (direction: number) => {
    const next = new Date(first);
    next.setUTCMonth(next.getUTCMonth() + direction);
    setMonth({ year: next.getUTCFullYear(), index: next.getUTCMonth() });
  };

  return (
    <div ref={anchorRef} className="kavla-knob-time-input" data-knob-time-input={pickerId}>
      <input
        className="kavla-knob-input"
        type="text"
        aria-label={label}
        aria-invalid={invalid}
        placeholder={type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DD HH:mm:ss"}
        value={draft}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setInvalid(!applyText(event.currentTarget.value));
        }}
        onBlur={() => {
          setDraft(saved);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <button
        className="kavla-knob-calendar-button"
        type="button"
        disabled={disabled}
        aria-label={`Choose ${label}`}
        aria-expanded={open}
        aria-controls={`${pickerId}-calendar`}
        onClick={() => onOpenChange(!open)}
      >
        <CalendarDays size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pickerRef}
            id={`${pickerId}-calendar`}
            data-knob-time-input={pickerId}
            className="kavla-knob-calendar"
            role="dialog"
            aria-label={`Choose ${label}`}
            style={position}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="kavla-knob-calendar-header">
              <button
                type="button"
                aria-label="Previous month"
                disabled={month.year === 1 && month.index === 0}
                onClick={() => moveMonth(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <select
                className="kavla-knob-input"
                aria-label="Month"
                value={month.index}
                onChange={(event) => setMonth({ ...month, index: Number(event.currentTarget.value) })}
              >
                {months.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                className="kavla-knob-input"
                type="number"
                aria-label="Year"
                min={1}
                max={9999}
                value={month.year}
                onChange={(event) => {
                  const year = event.currentTarget.valueAsNumber;
                  if (Number.isInteger(year) && year >= 1 && year <= 9999) setMonth({ ...month, year });
                }}
              />
              <button
                type="button"
                aria-label="Next month"
                disabled={month.year === 9999 && month.index === 11}
                onClick={() => moveMonth(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="kavla-knob-calendar-days">
              {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
                <span key={index}>{day}</span>
              ))}
              {Array.from({ length: dayOffset }, (_, index) => (
                <span key={`blank-${index}`} />
              ))}
              {Array.from({ length: last.getUTCDate() }, (_, index) => {
                const day = index + 1;
                const date = new Date(first);
                date.setUTCDate(day);
                const text = formatKnobTime(date.getTime(), "date");
                return (
                  <button
                    key={day}
                    type="button"
                    aria-label={text}
                    aria-pressed={text === saved.slice(0, 10)}
                    onClick={() => {
                      const next = type === "date" ? text : `${text} ${saved.slice(11)}`;
                      setInvalid(!applyText(next));
                    }}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            {type !== "date" && (
              <input
                className="kavla-knob-input"
                type="text"
                aria-label="Time"
                placeholder="HH:mm:ss"
                value={timeDraft}
                spellCheck={false}
                onChange={(event) => {
                  setTimeDraft(event.currentTarget.value);
                  setInvalid(!applyText(`${saved.slice(0, 10)} ${event.currentTarget.value}`));
                }}
                onBlur={() => setTimeDraft(saved.slice(11))}
              />
            )}
            <div className="kavla-knob-calendar-footer">
              <button className="kavla-knob-calendar-ok" type="button" onClick={() => onOpenChange(false)}>
                OK
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
