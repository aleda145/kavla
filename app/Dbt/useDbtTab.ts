import { useEditor, useValue } from "tldraw";
import type { SQLTextAreaShape } from "../SQLTextArea/sql-text-area-types";
import type { DataSourceShape } from "../DataSource/data-source-types";
import type { ShapeEngineTab } from "../util/ShapeEngineTabs";
import { dbtFileView, dbtRelation, dbtDocumentation } from "./dbtCanvas";
import { dbtState } from "./dbtRuntime";

export function useDbtTab(shape: SQLTextAreaShape | DataSourceShape): ShapeEngineTab | null {
  const editor = useEditor();
  return useValue(
    "dbt relation tab",
    () => {
      const relation = dbtRelation(shape);
      if (!relation) return null;
      const state = dbtState.get();
      const connected = Boolean(relation.bindingId && state.project?.binding?.id === relation.bindingId);
      const file =
        dbtFileView(shape) ??
        editor.getCurrentPageShapes().flatMap((candidate) => {
          const view = dbtFileView(candidate);
          return view && view.props.bindingId === relation.bindingId && view.props.path === relation.path ? [view] : [];
        })[0];
      const diskFile = connected
        ? state.project?.files.find((candidate) => candidate.path === relation.path)
        : undefined;
      const documentation = dbtDocumentation(shape);
      const issue = state.issues[shape.id] ?? (file ? state.issues[file.id] : undefined);
      const status = !connected
        ? "Detached from project"
        : state.error
          ? "Sync unavailable"
          : issue
            ? issue.message
            : state.paused
              ? "Sync paused"
              : file && file.props.text !== file.props.baseText
                ? "Unsaved canvas edits"
                : !file && !diskFile
                  ? "Project file unavailable"
                  : shape.type === "data-source" &&
                      !relation.source &&
                      relation.revision !== (file?.props.revision ?? diskFile?.revision)
                    ? "Seed import pending"
                    : "Synced with disk";
      const kind =
        shape.type === "sql-text-area" ? (shape.props.dbt?.kind ?? "model") : relation.source ? "source" : "seed";
      const reference = relation.source
        ? `source(${JSON.stringify(relation.source)}, ${JSON.stringify(relation.table)})`
        : `ref(${JSON.stringify(relation.refName)})`;
      const details = [
        `Project: ${relation.projectName}`,
        ...(["model", "source", "seed"].includes(kind) ? [`Reference: ${reference}`] : []),
        ...(relation.path ? [`File: ${relation.path}`] : []),
        ...(file?.props.projectRoot
          ? [`Folder: ${file.props.projectRoot}`]
          : connected
            ? [`Folder: ${state.project!.binding!.root}`]
            : []),
        `Sync: ${status}`,
        ...(connected && state.error ? [state.error] : []),
        ...(file?.props.readOnly ? ["Read-only file preview"] : []),
        ...(connected && state.lastSync ? [`Last synced: ${new Date(state.lastSync).toLocaleTimeString()}`] : []),
      ];
      if (documentation) {
        if (documentation.description) details.push(documentation.description);
        if (documentation.sourceDescription) details.push(`Source: ${documentation.sourceDescription}`);
        details.push(`Properties: ${documentation.path}`);
        if (documentation.materialized) details.push(`YAML materialization: ${documentation.materialized}`);
        if (documentation.tags.length) details.push(`Tags: ${documentation.tags.join(", ")}`);
        if (documentation.tests.length) details.push(`Declared tests: ${documentation.tests.join(", ")}`);
        for (const column of documentation.columns) {
          details.push(
            `${column.name}${column.dataType ? ` (${column.dataType})` : ""}${column.description ? `: ${column.description}` : ""}${column.tests.length ? ` · Tests: ${column.tests.join(", ")}` : ""}`
          );
        }
      }
      if (shape.type === "sql-text-area") {
        const upstream = (shape.props.upstreamShapeIds ?? []).flatMap((id) => {
          const input = editor.getShape(id as SQLTextAreaShape["id"]);
          return input && "name" in input.props ? [String(input.props.name)] : [];
        });
        if (upstream.length)
          details.push(
            `Upstream: ${upstream.slice(0, 8).join(", ")}${upstream.length > 8 ? ` and ${upstream.length - 8} more` : ""}`
          );
        details.push("Run previews this model and its upstream SQL. It does not materialize the dbt model.");
      } else {
        if (shape.props.remoteTableRef) details.push(`Table: ${shape.props.remoteTableRef}`);
        if (shape.props.rowCount !== null) details.push(`Rows: ${shape.props.rowCount.toLocaleString()}`);
        if (shape.props.error) details.push(shape.props.error);
        if (!relation.source) details.push("CSV seed imported into this canvas.");
      }
      details.push("Click to open dbt project settings.");
      return {
        key: `dbt-${shape.id}`,
        type: "dbt",
        active: false,
        topOffset: 0,
        title: `dbt ${kind}: ${relation.source ? `${relation.source}.${relation.table}` : relation.refName}`,
        details,
        onClick: () => window.dispatchEvent(new CustomEvent("kavla:open-dbt", { detail: file?.id })),
      };
    },
    [editor, shape]
  );
}
