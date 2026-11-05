import { Play, Square } from "lucide-react";
import { QueryEstimate } from "../util/QueryEstimate";
import type { QueryScan } from "../client/localServer/types";
import type { QueryEstimateRequest } from "../client/queryEstimate";

export function SQLBizAnalysisControls({
  auto,
  setAuto,
  retry,
  canRun,
  loading,
  stop,
  canStop,
  estimateRequest,
  estimateUnavailableReason,
  hasRun,
  scan,
}: {
  auto: boolean;
  setAuto: (checked: boolean) => void;
  retry: () => void;
  canRun: boolean;
  loading: boolean;
  stop: () => void;
  canStop: boolean;
  estimateRequest: QueryEstimateRequest | null;
  estimateUnavailableReason?: string;
  hasRun: boolean;
  scan?: QueryScan;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-2 mt-2 text-black">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <label className="flex min-w-0 items-center gap-2 text-[11px] font-bold leading-snug cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 cursor-pointer rounded-none border-2 border-black accent-black"
              checked={auto}
              disabled={!canRun}
              onChange={(event) => setAuto(event.target.checked)}
            />
            <span>Auto-run</span>
          </label>
          <QueryEstimate
            request={estimateRequest}
            unavailableReason={estimateUnavailableReason}
            disabled={loading}
            hasRun={hasRun}
            scan={scan}
          />
        </div>
        <button
          type="button"
          onClick={loading ? stop : retry}
          disabled={!canRun || (loading && !canStop)}
          aria-busy={loading}
          className="h-9 px-4 shrink-0 text-xs font-black bg-orange-100 text-black border-2 border-black hover:bg-orange-200 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all tracking-tight flex items-center gap-2 justify-center rounded cursor-pointer disabled:cursor-default"
        >
          {loading ? <Square size={16} aria-hidden /> : <Play size={16} aria-hidden />}
          {loading ? "Stop" : "Run"}
        </button>
      </div>
    </div>
  );
}
