import { canvasSQLSignature, rememberCompiledDbtModels } from "../Dbt/dbtCompilation";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import type { Editor, TLShapeId } from "tldraw";
import { sessionFetch } from "../client/backendCompute";
import { dbtContextShape, hasDbtTemplate } from "../Dbt/dbtSQL";
import { dbtState } from "../Dbt/dbtRuntime";
import { dbtFileView, dbtRelation } from "../Dbt/dbtCanvas";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";
import { walkSQLDag, buildRemoteSQLFromDag, describeQueryExecution, getMissingSourceMessage } from "./walkSQLDag";
import { getSQLKnobs } from "../Knob/knobSQL";

export async function prepareCanvasSQL(editor: Editor, sql: string, signal?: AbortSignal) {
  const initial = getOrderedDependenciesForSQL(editor, sql);
  const truncated = initial.orderedDependencies.find(
    (shape) => shape.type === "sql-text-area" && shape.props.dbt?.readOnly
  );
  if (truncated) throw new Error(`Model "${truncated.props.name}" is a truncated file preview and cannot be run.`);
  const usesDbt =
    hasDbtTemplate(sql) ||
    initial.orderedDependencies.some((shape) => shape.type === "sql-text-area" && hasDbtTemplate(shape.props.text));
  if (!usesDbt) {
    const plan = walkSQLDag(editor, sql);
    if (!plan.ok) throw new Error(plan.error.message);
    return { ...plan.plan, sql: buildRemoteSQLFromDag(sql, plan.plan.orderedDependencies, editor) };
  }
  const signature = canvasSQLSignature(editor);
  const shapes = editor.getCurrentPageShapes();
  const files = shapes.flatMap((shape) => {
    const file = dbtFileView(shape);
    return file ? [file] : [];
  });
  const project = dbtState.get().project;
  const config = project?.files.find((file) => file.path === "dbt_project.yml");
  if (!config || !project?.binding) throw new Error("Connect a dbt project to evaluate its Jinja expressions.");
  const bindingId = project.binding.id;
  const models = shapes.flatMap((shape) => {
    const model = dbtContextShape(shape);
    const file = dbtFileView(shape);
    if (shape.type === "sql-text-area" && file?.props.readOnly) return [];
    if (model && dbtRelation(shape)?.bindingId === bindingId) return [model];
    // Ordinary canvas queries can be used upstream of a dbt model as well.
    if (shape.type === "sql-text-area" && !file)
      return [
        {
          id: shape.id,
          name: (shape as SQLTextAreaShape).props.name,
          refName: (shape as SQLTextAreaShape).props.name,
          package: "",
          sql: (shape as SQLTextAreaShape).props.text,
          source: "",
          table: "",
        },
      ];
    return [];
  });
  const response = await sessionFetch("/api/dbt/compile", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bindingId,
      sql,
      models,
      projectYaml: config.text,
      macros: files
        .filter(
          (file) =>
            file.props.bindingId === bindingId && file.props.kind === "macro" && file.props.path.endsWith(".sql")
        )
        .map((file) => file.props.text),
      required: [
        ...new Set([
          ...initial.orderedDependencies.filter((shape) => shape.type === "sql-text-area").map((shape) => shape.id),
          ...models.filter((model) => model.sql === sql).map((model) => model.id),
        ]),
      ],
    }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error || "Could not compile dbt SQL.");
  }
  const compiled = (await response.json()) as {
    sql: string;
    models: Record<string, string>;
    dependencies: Record<string, string[]>;
  };
  signal?.throwIfAborted();
  if (canvasSQLSignature(editor) !== signature)
    throw new Error("Canvas inputs changed while compiling dbt SQL. Run it again.");
  rememberCompiledDbtModels(editor, compiled.models);
  const plan = getOrderedDependenciesForSQL(editor, compiled.sql, compiled.models);
  if (plan.cycle) throw new Error(plan.cycle);
  const missing = getMissingSourceMessage(plan.orderedDependencies);
  if (missing) throw new Error(missing);
  return {
    sql: buildRemoteSQLFromDag(compiled.sql, plan.orderedDependencies, editor, compiled.models),
    orderedDependencies: plan.orderedDependencies,
    executionState: describeQueryExecution(plan.orderedDependencies),
    nextUpstreamShapeIds: [
      ...new Set<TLShapeId>([...plan.immediateUpstreamIds, ...getSQLKnobs(editor, sql).map((knob) => knob.id)]),
    ],
  };
}
