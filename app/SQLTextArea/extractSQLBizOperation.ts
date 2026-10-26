import { createShapeId, getArrowBindings, type Editor, type TLArrowShape, type TLShapeId } from "tldraw";
import { getUniqueName } from "../util/getUniqueName";
import { extractTableNames } from "../util/parseSql";
import { setShapeUpstreamConnections } from "../util/shapeConnections";
import { getSQLKnobs } from "../Knob/knobSQL";
import { clearQuerySQLSize, isBizMode, setQueryBizMode } from "../client/canvas/bizMode";
import { getOrderedDependenciesForSQL, type SQLDependencyShape } from "./sqlDependencies";
import { getSQLBizSummary } from "./sqlBizSummary";
import { getAutoExpandedSQLShapeSize } from "./sqlShapeSize";
import { planSQLBizExtraction, type BizExtractionPlan } from "./sqlBizExtraction";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { walkSQLDag } from "./walkSQLDag";

type CanvasExtractionPlan =
  | { enabled: false; reason: string }
  | (Extract<BizExtractionPlan, { enabled: true }> & { upstreamName: string; original: SQLTextAreaShape });

export function getSQLBizExtractionPlan(editor: Editor, shapeId: TLShapeId, stepIndex: number): CanvasExtractionPlan {
  const disabled = (reason: string): CanvasExtractionPlan => ({ enabled: false, reason });
  const shape = editor.getShape<SQLTextAreaShape>(shapeId);
  if (!shape || shape.type !== "sql-text-area") return disabled("The query is no longer available.");
  if (editor.getInstanceState().isReadonly || shape.isLocked)
    return disabled("Unlock this query to extract an operation.");
  if (shape.props.isRunning) return disabled("Wait for this query to finish running.");
  if (shape.props.error) return disabled("Fix the query error before extracting an operation.");
  if (shape.props.isDirty || shape.props.stale || !shape.props.lastRunStats || !shape.props.outputSchema) {
    return disabled("Run this query first so extraction uses its current output columns.");
  }
  const summary = getSQLBizSummary(shape.props.text);
  const step = summary.steps[stepIndex];
  if (summary.error || !step) return disabled(summary.error ?? "This operation is no longer available.");
  const dependencies = walkSQLDag(editor, shape.props.text);
  if (!dependencies.ok) return disabled(dependencies.error.message);
  if (dependencies.plan.orderedDependencies.some((input) => input.id === shape.id)) {
    return disabled("The query has a circular dependency.");
  }
  const { executionState } = dependencies.plan;
  if (executionState.sourceNativePreview && executionState.sourceType?.toLowerCase() !== "duckdb") {
    return disabled("Extraction currently supports queries executed by DuckDB.");
  }
  if (
    dependencies.plan.orderedDependencies.some(
      (input) =>
        input.type === "sql-text-area" &&
        (input.props.isRunning || input.props.isDirty || input.props.stale || input.props.error)
    )
  ) {
    return disabled("Run the upstream queries first so their columns and results are current.");
  }
  const names = extractTableNames(shape.props.text);
  if (names.length !== 1) return disabled("Extraction requires one unambiguous source table.");
  const sources = editor.getCurrentPageShapes().filter((candidate): candidate is SQLDependencyShape => {
    if (candidate.type !== "sql-text-area" && candidate.type !== "data-source") return false;
    return (candidate as SQLDependencyShape).props.name.toLowerCase() === names[0].toLowerCase();
  });
  if (sources.length !== 1) return disabled("The source must resolve to exactly one canvas table or query.");
  const source = sources[0];
  const columns = source.type === "sql-text-area" ? source.props.outputSchema : source.props.metadata;
  const namePrefix = `${shape.props.name}_before_${step.label.toLowerCase().replaceAll(" ", "_")}`;
  // A new canvas name must not capture an existing reference to a backend-only table.
  const referencedNames = new Set(
    editor
      .getCurrentPageShapes()
      .filter((candidate): candidate is SQLTextAreaShape => candidate.type === "sql-text-area")
      .flatMap((candidate) => extractTableNames(candidate.props.text).map((name) => name.toLowerCase()))
  );
  let upstreamName = getUniqueName(editor, namePrefix);
  for (let suffix = 1; referencedNames.has(upstreamName.toLowerCase()); suffix++) {
    upstreamName = getUniqueName(editor, `${namePrefix}_${suffix}`);
  }
  const plan = planSQLBizExtraction(
    shape.props.text,
    step,
    { name: source.props.name, columns: columns ?? [] },
    upstreamName,
    shape.props.isDirty || shape.props.stale ? null : shape.props.outputSchema
  );
  return plan.enabled ? { ...plan, upstreamName, original: shape } : plan;
}

function extractionPosition(
  editor: Editor,
  original: SQLTextAreaShape,
  direction: "upstream" | "downstream",
  size: { w: number; h: number },
  retainedSize: { w: number; h: number }
) {
  const bounds = editor.getShapePageBounds(original)!;
  const arrows = editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.type !== "arrow" || shape.meta.kavlaConnector !== true) return [];
    const bindings = getArrowBindings(editor, shape as TLArrowShape);
    const current = direction === "upstream" ? bindings.end : bindings.start;
    const other = direction === "upstream" ? bindings.start : bindings.end;
    if (current?.toId !== original.id || !other || editor.getShape(other.toId)?.type !== "sql-text-area") return [];
    const neighbor = editor.getShapePageBounds(other.toId);
    if (!neighbor) return [];
    return [
      {
        id: shape.id,
        center: neighbor.center,
        distance: (neighbor.center.x - bounds.center.x) ** 2 + (neighbor.center.y - bounds.center.y) ** 2,
      },
    ];
  });
  arrows.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const fallback = direction === "upstream" ? -1 : 1;
  const dx = arrows[0] ? arrows[0].center.x - bounds.center.x : fallback;
  const dy = arrows[0] ? arrows[0].center.y - bounds.center.y : 0;
  const length = Math.hypot(dx, dy);
  const ux = length ? dx / length : fallback;
  const uy = length ? dy / length : 0;
  const rotation = editor.getShapePageTransform(original).rotation();
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const extractedCos = direction === "downstream" ? cos : 1;
  const extractedSin = direction === "downstream" ? sin : 0;
  const halfWidth =
    (Math.abs(cos) * retainedSize.w +
      Math.abs(sin) * retainedSize.h +
      Math.abs(extractedCos) * size.w +
      Math.abs(extractedSin) * size.h) /
    2;
  const halfHeight =
    (Math.abs(sin) * retainedSize.w +
      Math.abs(cos) * retainedSize.h +
      Math.abs(extractedSin) * size.w +
      Math.abs(extractedCos) * size.h) /
    2;
  // Stay beside the retained stage, regardless of how far away the connected query is.
  const distance = Math.min(ux ? halfWidth / Math.abs(ux) : Infinity, uy ? halfHeight / Math.abs(uy) : Infinity) + 40;
  return {
    x: bounds.center.x + ux * distance - (extractedCos * size.w - extractedSin * size.h) / 2,
    y: bounds.center.y + uy * distance - (extractedSin * size.w + extractedCos * size.h) / 2,
  };
}

export function extractSQLBizOperation(editor: Editor, shapeId: TLShapeId, stepIndex: number, expectedSQL: string) {
  const plan = getSQLBizExtractionPlan(editor, shapeId, stepIndex);
  if (!plan.enabled) throw new Error(plan.reason);
  const { original } = plan;
  if (original.props.text !== expectedSQL)
    throw new Error("The query changed. Reopen the operation before extracting it.");
  const bounds = editor.getShapePageBounds(original);
  if (!bounds) throw new Error("The query cannot be positioned on the canvas.");
  const upstreamId = createShapeId();
  const upstreamSize = getAutoExpandedSQLShapeSize(plan.upstreamSQL);
  const outputSize = getAutoExpandedSQLShapeSize(plan.outputSQL);
  const retainedSize = plan.direction === "upstream" ? outputSize : upstreamSize;
  const target = extractionPosition(
    editor,
    original,
    plan.direction,
    plan.direction === "upstream" ? upstreamSize : outputSize,
    retainedSize
  );
  const retainedPosition = editor.getPointInParentSpace(
    original,
    editor.getShapePageTransform(original).applyToPoint({
      x: (original.props.w - retainedSize.w) / 2,
      y: (original.props.h - retainedSize.h) / 2,
    })
  );
  const mark = editor.markHistoryStoppingPoint("extract-query-operation");
  const bizMode = isBizMode(editor, original.id);
  try {
    editor.run(() => {
      // The existing output id/name and result metadata stay with the final stage.
      // Charts, result tables, Lens widgets, and downstream SQL keep their references.
      editor.createShape<SQLTextAreaShape>({
        id: upstreamId,
        type: "sql-text-area",
        parentId: plan.direction === "upstream" ? editor.getCurrentPageId() : original.parentId,
        x: plan.direction === "upstream" ? target.x : retainedPosition.x,
        y: plan.direction === "upstream" ? target.y : retainedPosition.y,
        rotation: plan.direction === "upstream" ? 0 : original.rotation,
        props: {
          name: plan.upstreamName,
          text: plan.upstreamSQL,
          ...upstreamSize,
          isManuallyResized: true,
          isDirty: true,
          showTable: false,
          outputSchema: plan.upstreamSchema,
        },
      });
      const outputPosition =
        plan.direction === "downstream" ? editor.getPointInParentSpace(original, target) : retainedPosition;
      editor.updateShape<SQLTextAreaShape>({
        id: original.id,
        type: "sql-text-area",
        x: outputPosition.x,
        y: outputPosition.y,
        props: { text: plan.outputSQL, ...outputSize, isManuallyResized: true },
      });
      for (const [id, sql] of [
        [upstreamId, plan.upstreamSQL],
        [original.id, plan.outputSQL],
      ] as const) {
        const { immediateUpstreamIds } = getOrderedDependenciesForSQL(editor, sql);
        setShapeUpstreamConnections(editor, id, [
          ...immediateUpstreamIds,
          ...getSQLKnobs(editor, sql).map((knob) => knob.id),
        ]);
      }
    });
  } catch (error) {
    editor.bailToMark(mark);
    throw error;
  }
  setQueryBizMode(editor, upstreamId, bizMode);
  // SQL mode should fit the rewritten SQL instead of restoring pre-extraction sizes.
  clearQuerySQLSize(editor, upstreamId);
  clearQuerySQLSize(editor, original.id);
  const extracted =
    plan.direction === "upstream"
      ? { id: upstreamId, name: plan.upstreamName }
      : { id: original.id, name: original.props.name };
  editor.select(extracted.id);
  return extracted;
}
