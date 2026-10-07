import { createShapeId, type Editor, type TLShapeId } from "tldraw";
import type { KnobShape } from "../Knob/knob-types";
import { getUniqueKnobName } from "../Knob/createKnobs";
import { formatKnobTime, parseKnobTime, timeSteps } from "../Knob/knobTime";
import { getAgentLayout, getAgentPlacement } from "./agentLayout";

export function describeAgentKnob(knob: KnobShape) {
  const props = knob.props;
  const kind = props.kind === "category" && props.categoryType === "boolean" ? "boolean" : (props.kind ?? "numeric");
  return {
    id: knob.id,
    type: "knob",
    name: props.name,
    parameter: `{${props.name}}`,
    kind,
    value:
      kind === "boolean"
        ? props.categoryValue === "true"
        : kind === "category"
          ? props.categoryValue
          : kind === "timestamp"
            ? formatKnobTime(props.value, props.temporalType)
            : props.value,
    ...(kind === "numeric" ? { min: props.min, max: props.max, step: props.step } : {}),
    ...(kind === "timestamp"
      ? {
          min: formatKnobTime(props.min, props.temporalType),
          max: formatKnobTime(props.max, props.temporalType),
          step: timeSteps.find((step) => step.value === props.step)?.label.toLowerCase(),
          temporalType: props.temporalType ?? "timestamp",
        }
      : {}),
    ...(kind === "category" ? { options: props.options, optionsTruncated: props.optionsTruncated } : {}),
    downstreamShapeIds: props.downstreamShapeIds,
    inferFromColumn: props.inferFromColumn !== false,
    inferenceSourceId: props.inferenceSourceId,
    inferenceColumn: props.inferenceColumn,
    error: props.inferenceError,
  };
}

export function runAgentKnobTool(editor: Editor, args: Record<string, unknown>, updating: boolean) {
  if (editor.getInstanceState().isReadonly) throw new Error("This canvas is read-only.");
  const existing =
    updating && typeof args.shapeId === "string" ? editor.getShape(args.shapeId as TLShapeId) : undefined;
  if (updating && existing?.type !== "knob") throw new Error("shapeId must identify an existing knob.");
  if (existing && (existing.isLocked || editor.getShapeAncestors(existing).some((shape) => shape.isLocked)))
    throw new Error("This knob is locked.");
  const name = existing ? (existing as KnobShape).props.name : args.name;
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(
      "A knob name must start with a letter or underscore and contain only letters, digits, and underscores."
    );
  if (!existing && getUniqueKnobName(editor, name) !== name)
    throw new Error(`Knob ${name} already exists. Reuse it or configure it with update_knob.`);

  const props: Partial<KnobShape["props"]> = {
    name,
    inferFromColumn: false,
    inferenceColumn: undefined,
    inferenceSourceId: undefined,
    inferenceStatus: "ready",
    inferenceError: null,
    optionsTruncated: false,
  };
  const number = (key: string) => {
    const value = args[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a finite number.`);
    return value;
  };
  if (args.kind === "numeric" || args.kind === "timestamp") {
    const kind = args.kind;
    const temporalType = args.temporalType ?? "timestamp";
    if (
      kind === "timestamp" &&
      temporalType !== "date" &&
      temporalType !== "timestamp" &&
      temporalType !== "timestamptz"
    )
      throw new Error("temporalType must be date, timestamp, or timestamptz.");
    const readValue = (key: string) => {
      if (kind === "numeric") return number(key);
      const value = Math.floor(parseKnobTime(args[key]) / 1000) * 1000;
      return temporalType === "date" ? Math.floor(value / 86_400_000) * 86_400_000 : value;
    };
    const min = readValue("min");
    const max = readValue("max");
    const value = readValue("value");
    const step =
      kind === "numeric" ? number("step") : timeSteps.find((option) => option.label.toLowerCase() === args.step)?.value;
    if (step === undefined || step <= 0 || (kind === "timestamp" && temporalType === "date" && step < 86_400_000))
      throw new Error(
        "Provide a positive numeric step, or a timestamp step: second, minute, hour, day, week, year (date-only: day, week, year)."
      );
    if (min > max || !Number.isFinite(max - min) || value < min || value > max)
      throw new Error("The range must be finite with min <= value <= max.");
    Object.assign(props, { kind, min, max, value, step, ...(kind === "timestamp" ? { temporalType } : {}) });
  } else if (args.kind === "category") {
    if (
      !Array.isArray(args.options) ||
      !args.options.length ||
      args.options.length > 200 ||
      !args.options.every((option): option is string => typeof option === "string")
    )
      throw new Error("Category knobs require 1–200 string options taken from the data.");
    if (typeof args.value !== "string" || !args.options.includes(args.value))
      throw new Error("The initial category value must be one of the supplied options.");
    Object.assign(props, {
      kind: "category",
      categoryType: "text",
      categoryValue: args.value,
      options: [...new Set(args.options)],
    });
  } else if (args.kind === "boolean") {
    if (typeof args.value !== "boolean") throw new Error("Boolean knobs require an explicit true or false value.");
    Object.assign(props, {
      kind: "boolean",
      categoryType: "boolean",
      categoryValue: String(args.value),
      options: ["false", "true"],
    });
  } else throw new Error("kind must be numeric, category, timestamp, or boolean.");

  const id = existing?.id ?? createShapeId();
  if (existing) editor.updateShape<KnobShape>({ id, type: "knob", props });
  else {
    if (typeof args.anchorShapeId !== "string" || !editor.getShape(args.anchorShapeId as TLShapeId))
      throw new Error("anchorShapeId must identify the nearby source or query.");
    const anchorId = args.anchorShapeId as TLShapeId;
    const placement = getAgentPlacement(editor, getAgentLayout(args, anchorId, "above"), anchorId, { w: 240, h: 126 });
    editor.createShape<KnobShape>({ id, type: "knob", x: placement.x, y: placement.y, props });
  }
  const knob = editor.getShape<KnobShape>(id)!;
  return {
    ok: true,
    shapeId: id,
    name,
    parameter: `{${name}}`,
    knob: describeAgentKnob(knob),
    guidance:
      "Use the unquoted parameter in create_query or update_query SQL to connect this knob. Connected queries rerun automatically when its value changes.",
  };
}
