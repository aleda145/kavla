import {
  Coordinator,
  lruCache,
  type ArrowQueryRequest,
  type ExecQueryRequest,
  type Connector,
  type ArrowIPCBytes,
} from "@uwdata/mosaic-core";
import { isSelectQuery } from "@uwdata/mosaic-sql";

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

// Mosaic 0.33's consolidator neither carries request options to merged queries
// nor exposes its animation-frame queue to cancel(). Keep live/signal requests
// on the immediate path and explicitly settle detached consumers below.
class VisualizationCoordinator extends Coordinator {
  private outstanding = new Set<ReturnType<Coordinator["query"]>>();

  override query(...[query, options = {}]: Parameters<Coordinator["query"]>) {
    const consolidate =
      isSelectQuery(query) && options.cache !== false && !options.signal && options.priority === undefined;
    if (!consolidate) this.manager.consolidate(false);
    const result = super.query(query, options);
    if (!consolidate) this.manager.consolidate(true);
    this.outstanding.add(result);
    void result.then(
      () => this.outstanding.delete(result),
      () => this.outstanding.delete(result)
    );
    return result;
  }

  override cancel(requests: Parameters<Coordinator["cancel"]>[0]) {
    super.cancel(requests);
    for (const result of requests) {
      if (this.outstanding.has(result as ReturnType<Coordinator["query"]>)) result.reject("Canceled");
    }
  }

  override clear(options?: Parameters<Coordinator["clear"]>[0]) {
    // Coordinator invokes clear() before subclass fields are initialized.
    this.outstanding?.forEach((result) => result.reject("Cleared"));
    this.outstanding?.clear();
    super.clear(options);
  }
}

export function createVisualizationSession(execute: ExecuteArrow) {
  const connector = new KavlaConnector(execute);
  const coordinator = new VisualizationCoordinator(connector, {
    logger: null,
    cache: lruCache({ maxBytes: 32 * 1024 * 1024 }),
    consolidate: true,
    // Preaggregation requires supported linked interval/point filters. Charts
    // currently use full-source queries and exact polygon snapshots instead.
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
