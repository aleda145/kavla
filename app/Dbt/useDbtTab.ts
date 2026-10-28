import { useEditor, useValue } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import type { ShapeEngineTab } from "../util/ShapeEngineTabs";
import { dbtFileView, dbtRelation, dbtDocumentation } from "./dbtCanvas";

export function useDbtTab(shape: SQLTextAreaShape | DataSourceShape): ShapeEngineTab | null {
  const editor = useEditor();
  return useValue(
    "dbt relation tab",
    () => {
      const relation = dbtRelation(shape);
      if (!relation) return null;
      const documentation = dbtDocumentation(shape);
      const kind =
        shape.type === "sql-text-area" ? (shape.props.dbt?.kind ?? "model") : relation.source ? "source" : "seed";
      const details = [`Project: ${relation.projectName}`];
      if (documentation) {
        if (documentation.description) details.push(documentation.description);
        if (documentation.sourceDescription) details.push(`Source: ${documentation.sourceDescription}`);
        if (documentation.materialized) details.push(`Materialization: ${documentation.materialized}`);
        if (documentation.tags.length) details.push(`Tags: ${documentation.tags.join(", ")}`);
        if (documentation.tests.length) details.push(`Declared tests: ${documentation.tests.join(", ")}`);
      }
      return {
        key: `dbt-${shape.id}`,
        type: "dbt",
        active: false,
        topOffset: 0,
        title: `dbt ${kind}: ${relation.source ? `${relation.source}.${relation.table}` : relation.refName}`,
        details,
        onClick: () => {
          const file =
            dbtFileView(shape) ??
            editor.getCurrentPageShapes().flatMap((candidate) => {
              const view = dbtFileView(candidate);
              return view && view.props.bindingId === relation.bindingId && view.props.path === relation.path
                ? [view]
                : [];
            })[0];
          window.dispatchEvent(new CustomEvent("kavla:open-dbt", { detail: file?.id }));
        },
      };
    },
    [editor, shape]
  );
}
