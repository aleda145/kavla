import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useValue } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import { getActiveLocalSession } from "../client/local/localSession";
import {
  estimateQuery,
  formatEstimatedQueryCost,
  formatProcessedBytes,
  supportsQueryEstimate,
  type QueryEstimateRequest,
} from "../client/queryEstimate";

import type { QueryScan } from "../client/localServer/types";

type EstimateState = { key: string; bytes?: string; error?: string };
const staticEstimates = new Map<string, EstimateState>();
const staticEstimatesInFlight = new Map<string, Promise<EstimateState>>();

export function QueryEstimate({
  request,
  unavailableReason,
  disabled = false,
  compact = false,
  cacheStatic = false,
  hasRun = false,
  scan,
}: {
  request: QueryEstimateRequest | null;
  unavailableReason?: string;
  disabled?: boolean;
  compact?: boolean;
  cacheStatic?: boolean;
  hasRun?: boolean;
  scan?: QueryScan;
}) {
  const revision = useValue("Query estimate revision", () => backendRevision.get(), []);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<EstimateState | null>(null);
  const supported = request !== null && supportsQueryEstimate(request);
  const key = JSON.stringify([getActiveLocalSession()?.documentId, supported ? request : null, revision, refresh]);

  useEffect(() => {
    if (!supported || disabled || hasRun) return;
    if (cacheStatic && staticEstimates.has(key)) return;
    let active = true;
    const receive = (pending: Promise<EstimateState>) => {
      void pending.then((estimate) => {
        if (active) setResult(estimate);
      });
    };
    const existing = cacheStatic ? staticEstimatesInFlight.get(key) : undefined;
    if (existing) {
      receive(existing);
    } else {
      const pending = estimateQuery(request!).then(
        (estimate): EstimateState => ({ key, bytes: estimate.bytesProcessed }),
        (error: unknown): EstimateState => ({ key, error: error instanceof Error ? error.message : String(error) })
      );
      if (cacheStatic) {
        if (staticEstimates.size >= 500) staticEstimates.delete(staticEstimates.keys().next().value!);
        staticEstimatesInFlight.set(key, pending);
        void pending.then((estimate) => {
          staticEstimatesInFlight.delete(key);
          staticEstimates.set(key, estimate);
        });
      }
      receive(pending);
    }
    return () => {
      // The compute supervisor discards its worker on request cancellation.
      // Let an in-flight dry run finish so typing/closing a hover cannot discard
      // loaded query results. Ignore its response once the inputs change.
      active = false;
    };
  }, [key, supported, disabled, cacheStatic, hasRun]);

  if (!supported && !unavailableReason) return null;
  const current = result?.key === key ? result : cacheStatic ? (staticEstimates.get(key) ?? null) : null;
  const loading = supported && !current && !disabled;

  if (compact) {
    const compactLabel =
      unavailableReason || current?.error
        ? "Estimate: unavailable"
        : current?.bytes !== undefined
          ? `Estimate: ${formatProcessedBytes(current.bytes)}`
          : loading
            ? "Estimate: loading"
            : "Estimate: —";
    return (
      <span className="min-w-0" aria-live="polite">
        <button
          type="button"
          className="flex max-w-full items-center gap-1 cursor-pointer hover:text-black disabled:cursor-default"
          title={current?.bytes !== undefined ? formatEstimatedQueryCost(current.bytes) : undefined}
          aria-label={unavailableReason || current?.error || compactLabel}
          aria-busy={loading}
          disabled={!supported || loading || disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? (
            <>
              Estimate: <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden />
            </>
          ) : (
            <span className="truncate">{compactLabel}</span>
          )}
        </button>
      </span>
    );
  }

  const bytes = hasRun ? scan?.bytesProcessed : current?.bytes;
  const prefix = hasRun ? "Scanned" : "Estimate";
  const error = hasRun ? scan?.error : unavailableReason || current?.error;
  return (
    <span
      className="whitespace-nowrap text-[10px] font-bold text-gray-600"
      aria-live="polite"
      aria-label={error}
      title={bytes !== undefined ? formatEstimatedQueryCost(bytes) : undefined}
    >
      {prefix}: {bytes !== undefined ? formatProcessedBytes(bytes) : loading && !hasRun ? "…" : "—"}
    </span>
  );
}
