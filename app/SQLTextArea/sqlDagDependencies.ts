import { DuckDBService } from "@/duckdb-service";
import type { Editor } from "tldraw";
import { isRemoteDataSource } from "../DataSource/remote-source-metadata";
import type { SQLDependencyShape } from "./sqlDependencies";
import { getOrderedDependenciesForSQL } from "./sqlDependencies";
import type { SQLTextAreaShape } from "./sql-text-area-types";
import { describeQueryExecution } from "./walkSQLDag";
import { ensureBundledSourceTable } from "../client/local/bundledTables";

type DependencyLoadOptions =
  | {
      mode: "validation";
    }
  | {
      mode: "execution";
      isRemoteExecution: boolean;
    };

const pendingLocalQueryViews = new Map<string, Promise<void>>();

function formatUpstreamError(error: unknown, tableName: string) {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message
      ? error.message
      : String(error);
  return `Error in upstream "${tableName}"\n\n${message}`;
}

export async function loadSQLDagDependencies(
  orderedDependencies: SQLDependencyShape[],
  options: DependencyLoadOptions
): Promise<void> {
  if (options.mode === "execution" && options.isRemoteExecution) {
    return;
  }

  const duckDBService = DuckDBService.getInstance();
  await duckDBService.init();

  for (const dependency of orderedDependencies) {
    if (dependency.type === "data-source") {
      if (duckDBService.isTableLoaded(dependency.props.name) || isRemoteDataSource(dependency)) {
        continue;
      }

      const filename = dependency.props.filename;
      if (!filename) {
        if (options.mode === "validation") continue;
        throw new Error(`Local source "${dependency.props.name}" is missing file metadata.`);
      }

      if (options.mode === "validation") {
        try {
          await ensureBundledSourceTable({ shapeId: dependency.id, tableName: dependency.props.name, filename });
        } catch {
          // DuckDB validation reports the unresolved table with the query context.
        }
        continue;
      }

      try {
        const isAvailable = await ensureBundledSourceTable({
          shapeId: dependency.id,
          tableName: dependency.props.name,
          filename,
        });
        if (!isAvailable) {
          throw new Error("missing bundled source");
        }
      } catch {
        throw new Error(`Local file "${filename}" is missing from this .kavla document. Please re-import it.`);
      }
      continue;
    }

    try {
      await duckDBService.createQueryView(dependency.props.text, dependency.props.name);
    } catch (error) {
      throw new Error(formatUpstreamError(error, dependency.props.name));
    }
  }
}

export async function ensureLocalQueryView(editor: Editor, queryShape: SQLTextAreaShape): Promise<void> {
  const duckDBService = DuckDBService.getInstance();
  await duckDBService.init();
  if (duckDBService.isTableLoaded(queryShape.props.name)) return;

  const pending = pendingLocalQueryViews.get(queryShape.id);
  if (pending) return pending;

  const operation = (async () => {
    if (duckDBService.isTableLoaded(queryShape.props.name)) return;

    const { orderedDependencies } = getOrderedDependenciesForSQL(editor, queryShape.props.text);
    if (describeQueryExecution(orderedDependencies).isRemoteExecution) {
      throw new Error("This CLI query result is not loaded. Run the query to load it.");
    }

    await loadSQLDagDependencies(orderedDependencies, { mode: "execution", isRemoteExecution: false });
    await duckDBService.createQueryView(queryShape.props.text, queryShape.props.name);
  })();
  pendingLocalQueryViews.set(queryShape.id, operation);
  try {
    await operation;
  } finally {
    if (pendingLocalQueryViews.get(queryShape.id) === operation) {
      pendingLocalQueryViews.delete(queryShape.id);
    }
  }
}
