import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { createVisualizationSession } from "./coordinator.ts";

export function reuseBrowserConnection(connection: AsyncDuckDBConnection) {
  return createVisualizationSession(
    (sql, signal) =>
      new Promise<Uint8Array>((resolve, reject) => {
        signal.throwIfAborted();
        // Do not call cancelSent() on a shared connection: that could interrupt
        // unrelated SQL shapes. Discard obsolete replies; the host owns scheduling.
        connection
          .useUnsafe(async (bindings, handle) => {
            try {
              const bytes = await bindings.runQuery(handle, sql);
              signal.throwIfAborted();
              resolve(bytes);
            } catch (error) {
              reject(error);
            }
          })
          .catch(reject);
      })
  );
}
