import {
  Coordinator,
  lruCache,
  type ArrowQueryRequest,
  type ExecQueryRequest,
  type Connector,
  type ArrowIPCBytes,
} from "@uwdata/mosaic-core";

export type ExecuteArrow = (sql: string, signal: AbortSignal) => Promise<ArrowIPCBytes>;

// Mosaic 0.33 passes extra query options on the request, but does not propagate
// AbortSignal itself. Keep that compatibility detail out of React clients.
export class KavlaConnector implements Connector {
  private active = new Set<AbortController>();
  private disposed = false;
  constructor(private execute: ExecuteArrow) {}

  query(request: ArrowQueryRequest): Promise<ArrowIPCBytes>;
  query(request: ExecQueryRequest): Promise<void>;
  async query(
    request: (ArrowQueryRequest | ExecQueryRequest) & { signal?: AbortSignal }
  ): Promise<ArrowIPCBytes | void> {
    if (this.disposed) throw new Error("The visualization session has closed.");
    if (request.type !== "arrow")
      throw new Error("Visualization compute is read-only; automatic materialization is disabled.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.throwIfAborted();
    request.signal?.addEventListener("abort", abort, { once: true });
    this.active.add(controller);
    try {
      return await this.execute(request.sql, controller.signal);
    } finally {
      request.signal?.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }

  dispose() {
    this.disposed = true;
    this.active.forEach((controller) => controller.abort());
    this.active.clear();
  }
}

export function createVisualizationSession(execute: ExecuteArrow) {
  const connector = new KavlaConnector(execute);
  const coordinator = new Coordinator(connector, {
    logger: null,
    cache: lruCache({ maxBytes: 32 * 1024 * 1024 }),
    // String queries cannot use structural consolidation. In 0.33, cancelling
    // during the consolidator's animation-frame queue does not remove requests.
    consolidate: false,
    preagg: { enabled: false },
  });
  return {
    coordinator,
    dispose() {
      connector.dispose();
      coordinator.clear();
    },
  };
}

// A browser host can inject its EXISTING connection's raw IPC operation.
// No database is created or owned here. useUnsafe/runQuery is the same route
// used by Mosaic's wasmConnector({duckdb, connection}); see browser-connector.ts.
