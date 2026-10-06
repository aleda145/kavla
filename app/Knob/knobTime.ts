import type { KnobTemporalType } from "./knob-types";

export const yearStep = 31_536_000_000;
export const timeSteps = [
  { value: 1000, label: "Second" },
  { value: 60_000, label: "Minute" },
  { value: 3_600_000, label: "Hour" },
  { value: 86_400_000, label: "Day" },
  { value: 604_800_000, label: "Week" },
  { value: yearStep, label: "Year" },
];

// Naive timestamps use UTC milliseconds as wall-clock coordinates. Never let
// the browser's timezone shift a SQL timestamp that has no timezone of its own.
export function formatKnobTime(value: number, type: KnobTemporalType = "timestamp"): string {
  const date = new Date(value);
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    throw new Error("Timestamp knobs support dates from year 0001 to 9999.");
  const iso = date.toISOString();
  return type === "date" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

export function parseKnobTime(value: unknown): number {
  if (typeof value !== "string") throw new Error("This column's timestamp range could not be read.");
  const match = value
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?))?(?:\s*(Z|UTC|[+-]\d{2}(?::?\d{2})?))?$/i);
  if (!match) throw new Error("This column's timestamp range cannot be represented by a slider.");
  let zone = match[3] ?? "Z";
  if (zone.toUpperCase() === "UTC") zone = "Z";
  if (/^[+-]\d{2}$/.test(zone)) zone += ":00";
  const timestamp = Date.parse(`${match[1]}T${match[2] ?? "00:00:00"}${zone}`);
  formatKnobTime(timestamp);
  return timestamp;
}

export function getTimeStep(min: number, max: number, type: KnobTemporalType): number {
  const smallest = type === "date" ? 86_400_000 : 1000;
  return timeSteps.find((step) => step.value >= smallest && step.value >= (max - min) / 200)?.value ?? yearStep;
}

export function shiftKnobYears(value: number, years: number): number {
  const date = new Date(value);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + years);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.getTime();
}

export function timeSliderSteps(min: number, max: number, step: number): number {
  if (step !== yearStep) return Math.ceil((max - min) / step);
  const years = new Date(max).getUTCFullYear() - new Date(min).getUTCFullYear();
  return years + (shiftKnobYears(min, years) < max ? 1 : 0);
}

export function timeSliderValue(min: number, max: number, step: number, position: number): number {
  if (position >= timeSliderSteps(min, max, step)) return max;
  return step === yearStep ? shiftKnobYears(min, position) : Math.min(max, min + position * step);
}

export function timeSliderPosition(min: number, max: number, step: number, value: number): number {
  if (value >= max) return timeSliderSteps(min, max, step);
  if (step !== yearStep) return (value - min) / step;
  const years = new Date(value).getUTCFullYear() - new Date(min).getUTCFullYear();
  return Math.max(0, years - (shiftKnobYears(min, years) > value ? 1 : 0));
}
