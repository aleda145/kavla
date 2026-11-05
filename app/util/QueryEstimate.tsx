import { useEffect, useState } from "react";
import { FlaskConical, LoaderCircle } from "lucide-react";
import { useValue } from "tldraw";
import { backendRevision } from "../client/backendCompute";
import {
  estimateQuery,
  formatEstimatedQueryCost,
  formatProcessedBytes,
  supportsQueryEstimate,
  type QueryEstimateRequest,
} from "../client/queryEstimate";

type EstimateState = { key: string; bytes?: string; error?: string };

export function QueryEstimate({
  request,
  unavailableReason,
  disabled = false,
  compact = false,
}: {
  request: QueryEstimateRequest | null;
  unavailableReason?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const revision = useValue("Query estimate revision", () => backendRevision.get(), []);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<EstimateState | null>(null);
  const supported = request !== null && supportsQueryEstimate(request);
  const key = JSON.stringify([supported ? request : null, revision, refresh]);

  useEffect(() => {
    if (!supported || disabled) return;
    let active = true;
    const timer = setTimeout(() => {
      void estimateQuery(request!).then(
        (estimate) => {
          if (active) setResult({ key, bytes: estimate.bytesProcessed });
        },
        (error: unknown) => {
          if (active) {
            setResult({ key, error: error instanceof Error ? error.message : String(error) });
          }
        }
      );
    }, 650);
    return () => {
      clearTimeout(timer);
      // The compute supervisor discards its worker on request cancellation.
      // Let an in-flight dry run finish so typing/closing a hover cannot discard
      // loaded query results. Ignore its response once the inputs change.
      active = false;
    };
  }, [key, supported, disabled]);

  if (!supported && !unavailableReason) return null;
  const current = result?.key === key ? result : null;
  const loading = supported && !current && !disabled;
  const label = unavailableReason
    ? unavailableReason
    : current?.error
      ? `Estimate unavailable: ${current.error}`
      : current?.bytes !== undefined
        ? `~${formatProcessedBytes(current.bytes)} to process`
        : disabled
          ? "Estimate paused while running"
          : "Estimating bytes…";

  if (compact) {
    const compactLabel =
      unavailableReason || current?.error
        ? "Est.: unavailable"
        : current?.bytes !== undefined
          ? `Est.: ${formatProcessedBytes(current.bytes)}`
          : loading
            ? "Est.: loading"
            : "Est.: —";
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
              Est.: <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden />
            </>
          ) : (
            <span className="truncate">{compactLabel}</span>
          )}
        </button>
      </span>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-black/20 bg-blue-50 px-2 py-1.5 text-[10px] text-black">
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="font-bold break-words line-clamp-2" title={label}>
          {label}
        </div>
        {current?.bytes !== undefined && (
          <div
            className="text-gray-600"
            title="Decimal units: 1 GB = 1 billion bytes. Estimates can differ from actual processed or billed bytes."
          >
            BigQuery dry run · estimated scan, not billed bytes
          </div>
        )}
      </div>
      {supported && (
        <button
          type="button"
          className="kavla-icon-control flex shrink-0 cursor-pointer items-center gap-1 rounded border-2 border-black bg-blue-100 px-2 py-1 font-bold hover:bg-blue-200 disabled:cursor-default disabled:opacity-50"
          title="Dry run: validate and estimate bytes without executing the query"
          disabled={loading || disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? <LoaderCircle size={13} className="animate-spin" /> : <FlaskConical size={13} />}
          <span className="kavla-control-label">Dry run</span>
        </button>
      )}
    </div>
  );
}
