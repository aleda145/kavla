import { useEffect, useState } from "react";
import { useValue } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import { getActiveLocalSession } from "../client/local/localSession";
import { formatEstimatedQueryCost, formatProcessedBytes } from "../client/queryEstimate";
import { estimateSourceSample } from "./source-samples";

type Estimate = { bytes?: string; error?: string };
const estimates = new Map<string, { expires: number; promise: Promise<Estimate> }>();

export function SourceSampleEstimate({ tableRef, percent }: { tableRef: string; percent: number }) {
  const revision = useValue("Sample estimate revision", () => backendRevision.get(), []);
  const key = JSON.stringify([getActiveLocalSession()?.documentId, revision, tableRef, percent]);
  const [result, setResult] = useState<{ key: string; estimate: Estimate } | null>(null);
  useEffect(() => {
    let active = true;
    let pending = estimates.get(key);
    if (!pending || pending.expires < Date.now()) {
      pending = {
        expires: Date.now() + 60_000,
        promise: estimateSourceSample(tableRef, percent).then(
          (estimate): Estimate => ({ bytes: estimate.bytesProcessed }),
          (error: unknown): Estimate => ({ error: error instanceof Error ? error.message : String(error) })
        ),
      };
      if (estimates.size >= 500) estimates.delete(estimates.keys().next().value!);
      estimates.set(key, pending);
    }
    const requested = pending;
    void pending.promise.then((estimate) => {
      // Retry errors on the next hover instead of caching a failure for a minute.
      if (estimate.error && estimates.get(key) === requested) estimates.delete(key);
      if (active) setResult({ key, estimate });
    });
    return () => {
      // Cancelling a request discards the compute worker. Let this dry run
      // finish when the pointer leaves, and reuse its result on the next hover.
      active = false;
    };
  }, [key, tableRef, percent]);
  const estimate = result?.key === key ? result.estimate : null;
  return (
    <span aria-live="polite">
      {estimate?.error ? (
        <>
          <span>Creation estimate unavailable</span>
          <span className="kavla-source-sample-tooltip-details block">{estimate.error}</span>
        </>
      ) : estimate?.bytes !== undefined ? (
        <>
          <span>Create: ≈{formatEstimatedQueryCost(estimate.bytes)}</span>
          <span className="kavla-source-sample-tooltip-details block">
            {formatProcessedBytes(estimate.bytes)} · on-demand, storage extra
          </span>
        </>
      ) : (
        "Estimating creation…"
      )}
    </span>
  );
}
