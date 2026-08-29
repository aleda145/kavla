export const RUN_SQL_SHAPE_REQUEST_EVENT = "kavla:run-sql-shape-request";
export const SQL_SHAPE_RUN_STARTED_EVENT = "kavla:sql-shape-run-started";
export const SQL_SHAPE_RUN_FINISHED_EVENT = "kavla:sql-shape-run-finished";
const RUN_SQL_SHAPE_TIMEOUT_MS = 120000;

export interface SQLShapeRunResult {
  success: boolean;
  error?: string | null;
  rowCount?: number | null;
  outputSchema?: { name: string; type: string }[] | null;
  sampleRows?: Record<string, unknown>[] | null;
}

export interface RunSQLShapeRequestDetail {
  shapeId: string;
  sqlText?: string;
  resolve: (result: SQLShapeRunResult) => void;
}

export interface SQLShapeRunLifecycleDetail {
  shapeId: string;
  sqlText?: string;
  result?: SQLShapeRunResult;
}

export function dispatchSQLShapeRunStarted(shapeId: string, sqlText?: string) {
  window.dispatchEvent(
    new CustomEvent<SQLShapeRunLifecycleDetail>(SQL_SHAPE_RUN_STARTED_EVENT, {
      detail: { shapeId, sqlText },
    })
  );
}

export function dispatchSQLShapeRunFinished(shapeId: string, result: SQLShapeRunResult) {
  window.dispatchEvent(
    new CustomEvent<SQLShapeRunLifecycleDetail>(SQL_SHAPE_RUN_FINISHED_EVENT, {
      detail: { shapeId, result },
    })
  );
}

export function requestSQLShapeRun(
  shapeId: string,
  sqlText?: string,
  timeoutMs = RUN_SQL_SHAPE_TIMEOUT_MS
): Promise<SQLShapeRunResult> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Timed out while waiting for SQL shape ${shapeId} to finish running.`));
    }, timeoutMs);

    window.dispatchEvent(
      new CustomEvent<RunSQLShapeRequestDetail>(RUN_SQL_SHAPE_REQUEST_EVENT, {
        detail: {
          shapeId,
          sqlText,
          resolve: (result) => {
            window.clearTimeout(timeoutId);
            resolve(result);
          },
        },
      })
    );
  });
}
