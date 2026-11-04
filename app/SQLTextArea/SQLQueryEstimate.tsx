import { useValue, type Editor } from "tldraw";
import { QueryEstimate } from "../util/QueryEstimate";
import type { QueryEstimateRequest } from "../client/queryEstimate";
import { buildRemoteSQLFromDag, describeQueryExecution, walkSQLDag } from "./walkSQLDag";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";
import type { SQLTextAreaShape } from "./sql-text-area-types";

export function SQLQueryEstimate({ editor, shape }: { editor: Editor; shape: SQLTextAreaShape }) {
  const input = useValue(
    "SQL dry run inputs",
    (): { request: QueryEstimateRequest | null; unavailableReason?: string } => {
      const current = editor.getShape<SQLTextAreaShape>(shape.id);
      if (!current) return { request: null };
      const { orderedDependencies } = getOrderedDependenciesForSQL(editor, current.props.text);
      const execution = describeQueryExecution(orderedDependencies);
      if (!execution.tabs.some((tab) => tab.type === "bigquery")) return { request: null };
      if (!execution.sourceNativePreview) {
        return { request: null, unavailableReason: "BigQuery scan estimate unavailable for federated queries." };
      }
      try {
        const dag = walkSQLDag(editor, current.props.text);
        if (!dag.ok) throw new Error(dag.error.message);
        if (dag.plan.nextUpstreamShapeIds.includes(shape.id))
          throw new Error("A query cannot read from its own output.");
        return {
          request: {
            sql: buildRemoteSQLFromDag(current.props.text, dag.plan.orderedDependencies, editor),
            sourceName: execution.sourceName,
            sourceType: execution.sourceType,
            sourceNative: execution.sourceNativePreview,
          },
        };
      } catch (error) {
        return { request: null, unavailableReason: error instanceof Error ? error.message : String(error) };
      }
    },
    [editor, shape.id]
  );
  return <QueryEstimate {...input} disabled={shape.props.isRunning} />;
}
