import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Pipette } from "lucide-react";
import { useValue, type Editor, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "./data-source-types";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { SummaryShape } from "../Summary/summary-shape-types";
import { getOrderedDependenciesForSQL } from "../SQLTextArea/sqlDependencies";
import "./data-source-sample.css";

function getSourceSamples(editor: Editor, shapeId: TLShapeId) {
  const sources = new Map<TLShapeId, DataSourceShape>();
  const visited = new Set<TLShapeId>();
  const visit = (id: TLShapeId) => {
    if (visited.has(id)) return;
    visited.add(id);
    const shape = editor.getShape(id);
    if (!shape) return;
    if (shape.type === "data-source") {
      sources.set(id, shape as DataSourceShape);
    } else if (shape.type === "sql-text-area") {
      const query = shape as SQLTextAreaShape;
      // Follow the same SQL dependencies as execution, rather than saved arrows.
      for (const dependency of getOrderedDependenciesForSQL(editor, query.props.text).orderedDependencies) {
        if (dependency.type === "data-source") sources.set(dependency.id, dependency);
      }
    } else if (shape.type === "summary-shape") {
      for (const artifact of (shape as SummaryShape).props.artifacts) visit(artifact.shapeId as TLShapeId);
    } else if ("sourceShapeId" in shape.props && typeof shape.props.sourceShapeId === "string") {
      visit(shape.props.sourceShapeId as TLShapeId);
    }
  };
  visit(shapeId);
  return Array.from(sources.values(), (source) => ({
    id: source.id,
    name: source.props.name,
    percent: source.props.samplePercent ?? 100,
  }));
}

export function InheritedSourceSample({
  editor,
  shapeId,
  compact = false,
}: {
  editor: Editor;
  shapeId: TLShapeId;
  compact?: boolean;
}) {
  const sources = useValue("Inherited source sampling", () => getSourceSamples(editor, shapeId), [editor, shapeId]);
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const tooltipId = useId();
  const sampledSources = sources.filter((source) => source.percent < 100);
  if (!sampledSources.length) return null;

  const percentages = new Set(sources.map((source) => source.percent));
  const label = percentages.size === 1 ? `${sources[0].percent}%` : "Mixed";
  const description = sources.map((source) => `${source.name}: ${source.percent}%`).join(", ");

  return (
    <div className="kavla-source-sample">
      <button
        type="button"
        className={`kavla-source-sample-tab kavla-source-sample-inherited${compact ? " kavla-source-sample-compact" : ""}`}
        data-sampling="true"
        aria-label={`Go to sample source${sampledSources.length > 1 ? "s" : ""}: ${description}`}
        aria-describedby={tooltipRect ? tooltipId : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setTooltipRect(null);
          editor.select(...sampledSources.map((source) => source.id));
          editor.zoomToSelection({ animation: { duration: 250 } });
        }}
        onMouseEnter={(event) => setTooltipRect(event.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setTooltipRect(null)}
        onFocus={(event) => setTooltipRect(event.currentTarget.getBoundingClientRect())}
        onBlur={() => setTooltipRect(null)}
      >
        <Pipette size={compact ? 14 : 18} aria-hidden />
        <span>{label}</span>
      </button>
      {tooltipRect &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="kavla-source-sample-tooltip"
            style={{ left: tooltipRect.left + tooltipRect.width / 2, top: tooltipRect.top - 12 }}
          >
            Source sample
            <div className="kavla-source-sample-tooltip-details">
              {sources.map((source) => (
                <div key={source.id}>
                  {source.name}: {source.percent}%
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
