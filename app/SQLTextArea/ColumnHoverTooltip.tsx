import React, { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";

import { DuckDBService } from "../src/duckdb-service";
import { getColumnAnalysisSteps, getColumnAnalysisType } from "../src/duckdb/column-stats-sql";
import type { ColumnStats } from "../src/duckdb/column-stats-types";
import { getColumnTypeColor } from "../util/column-colors";
import { getRemoteHoverPolicy, RemoteHoverPolicy, setRemoteHoverPolicy } from "./remote-hover-policy";
import {
  getCachedRemoteColumnStats,
  getExistingRemoteColumnStats,
  invalidateRemoteColumnStats,
  type RemoteSourceInfo,
} from "./remote-column-stats";

interface ColumnHoverTooltipProps {
  columnName: string;
  type: string;
  tableName: string;
  precomputedStats?: ColumnStats | null;
  remoteSource?: RemoteSourceInfo | null;
  prepareLocalTable?: (() => Promise<void>) | null;
}

const ctaButtonClass =
  "h-9 px-4 text-xs font-black bg-orange-100 text-black border-2 border-black hover:bg-orange-200 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all tracking-tight flex items-center gap-2 justify-center rounded cursor-pointer";

export const ColumnHoverTooltip: React.FC<ColumnHoverTooltipProps> = ({
  columnName,
  type,
  tableName,
  precomputedStats,
  remoteSource,
  prepareLocalTable,
}) => {
  // Primitive dependencies avoid re-fetching when only the source object identity changes.
  const remoteSourceName = remoteSource?.sourceName;
  const remoteSourceType = remoteSource?.sourceType;
  const remoteTableRef = remoteSource?.fullTableRef;
  const remoteQueryFn = remoteSource?.runRemoteQuery;
  const remoteCancelQueryFn = remoteSource?.cancelRemoteQuery;
  const isRemoteCliSource = Boolean(remoteSourceName && remoteTableRef && remoteQueryFn);
  const [remoteHoverPolicy, setRemoteHoverPolicyState] = useState<RemoteHoverPolicy>(() =>
    getRemoteHoverPolicy(remoteSourceName, remoteSourceType)
  );
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [activeRemoteRequestId, setActiveRemoteRequestId] = useState<string | null>(null);
  const autoRunOnOpenRef = useRef(remoteHoverPolicy === "auto");
  const previousStatsRef = useRef<ColumnStats | null>(null);
  const initialCachedRemoteStats = getExistingRemoteColumnStats(remoteSourceName, remoteTableRef, columnName);
  const [stats, setStats] = useState<ColumnStats | null>(precomputedStats ?? initialCachedRemoteStats);
  const [loading, setLoading] = useState(() => {
    if (precomputedStats) {
      return false;
    }

    if (initialCachedRemoteStats) {
      return false;
    }

    if (isRemoteCliSource) {
      return remoteHoverPolicy === "auto";
    }

    return true;
  });

  useEffect(() => {
    const nextPolicy = getRemoteHoverPolicy(remoteSourceName, remoteSourceType);
    autoRunOnOpenRef.current = nextPolicy === "auto";
    setRemoteHoverPolicyState(nextPolicy);
    setAnalysisRequested(false);
  }, [remoteSourceName, remoteSourceType, remoteTableRef, tableName, columnName, type]);

  useEffect(() => {
    if (precomputedStats) {
      setStats(precomputedStats);
      setLoading(false);
      return;
    }

    let mounted = true;
    const cachedRemoteStats = getExistingRemoteColumnStats(remoteSourceName, remoteTableRef, columnName);

    if (cachedRemoteStats) {
      setActiveRemoteRequestId(null);
      setStats(cachedRemoteStats);
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    const shouldRunRemoteAnalysis = !isRemoteCliSource || analysisRequested || autoRunOnOpenRef.current;

    if (isRemoteCliSource && !shouldRunRemoteAnalysis) {
      setActiveRemoteRequestId(null);
      setStats(null);
      setLoading(false);
      return () => {
        mounted = false;
      };
    }

    setLoading(true);
    setStats(null);

    if (remoteSourceName && remoteTableRef && remoteQueryFn) {
      const requestShapeId = `hover_stats_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setActiveRemoteRequestId(requestShapeId);
      getCachedRemoteColumnStats(
        remoteQueryFn,
        remoteSourceName,
        remoteSourceType,
        remoteTableRef,
        columnName,
        type,
        requestShapeId,
        remoteSource.tableSql
      )
        .then((data) => {
          if (mounted) {
            previousStatsRef.current = null;
            setActiveRemoteRequestId(null);
            setStats(data);
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error("Remote column stats failed:", err);
          if (mounted) {
            setActiveRemoteRequestId(null);
            if (err?.name === "AbortError" || err?.message === "Query cancelled") {
              const previousStats = previousStatsRef.current;
              previousStatsRef.current = null;
              setStats(previousStats);
              setAnalysisRequested(Boolean(previousStats));
            } else {
              previousStatsRef.current = null;
              setStats({ type: "other", error: "Failed to load remote stats" });
            }
            setLoading(false);
          }
        });
    } else {
      setActiveRemoteRequestId(null);
      Promise.resolve()
        .then(() => prepareLocalTable?.())
        .then(() => DuckDBService.getInstance().getColumnStats(tableName, columnName, type))
        .then((data) => {
          if (mounted) {
            setStats(data);
            setLoading(false);
          }
        })
        .catch((err) => {
          console.error(err);
          if (mounted) {
            setStats({ type: "other", error: "Failed to load" });
            setLoading(false);
          }
        });
    }

    return () => {
      mounted = false;
    };
  }, [
    tableName,
    columnName,
    type,
    precomputedStats,
    isRemoteCliSource,
    remoteSourceName,
    remoteSourceType,
    remoteTableRef,
    remoteQueryFn,
    remoteCancelQueryFn,
    prepareLocalTable,
    analysisRequested,
    refreshVersion,
  ]);

  const showRemoteAnalysisGate = isRemoteCliSource && !precomputedStats && !analysisRequested && !loading && !stats;
  const showRemoteModeToggle = isRemoteCliSource && !precomputedStats;
  const autoAnalysisModeEnabled = remoteHoverPolicy === "auto";
  const remoteAnalysisType = getColumnAnalysisType(type);
  const remoteAnalysisSteps = getColumnAnalysisSteps(remoteAnalysisType);
  const visibleStats = stats ?? (loading && isRemoteCliSource ? previousStatsRef.current : null);

  const handleRemoteHoverPolicyChange = (shouldAlwaysAsk: boolean) => {
    const nextPolicy: RemoteHoverPolicy = shouldAlwaysAsk ? "ask" : "auto";
    setRemoteHoverPolicyState(nextPolicy);
    setRemoteHoverPolicy(remoteSourceName, remoteSourceType, nextPolicy);
  };

  const nullPct =
    visibleStats?.nullPercentage !== undefined
      ? typeof visibleStats.nullPercentage === "number"
        ? visibleStats.nullPercentage.toFixed(1) + "%"
        : "0%"
      : null;

  const renderRemoteModeToggle = (className = "") => {
    if (!showRemoteModeToggle) {
      return null;
    }

    return (
      <label
        className={`flex w-full min-w-0 items-center gap-2 text-[11px] font-bold leading-snug cursor-pointer select-none ${className}`.trim()}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-none border-2 border-black accent-black"
          checked={autoAnalysisModeEnabled}
          onChange={(event) => {
            handleRemoteHoverPolicyChange(!event.target.checked);
          }}
        />
        <span className="min-w-0 flex-1">Auto run column analysis</span>
      </label>
    );
  };

  const handleRunAnalysis = () => {
    previousStatsRef.current = stats;
    invalidateRemoteColumnStats(remoteSourceName, remoteTableRef, columnName);
    setLoading(true);
    setAnalysisRequested(true);
    setRefreshVersion((value) => value + 1);
  };

  const handleStopAnalysis = () => {
    if (!activeRemoteRequestId || !remoteCancelQueryFn) {
      return;
    }

    remoteCancelQueryFn(activeRemoteRequestId, `hover:${tableName}.${columnName}`);
  };

  const renderRunButton = () => {
    if (!isRemoteCliSource) {
      return null;
    }

    return (
      <button
        type="button"
        className={ctaButtonClass}
        onClick={loading ? handleStopAnalysis : handleRunAnalysis}
        disabled={loading && !activeRemoteRequestId}
      >
        {loading ? (
          <>
            <Square size={16} /> Stop
          </>
        ) : (
          <>
            <Play size={16} /> Run
          </>
        )}
      </button>
    );
  };

  const renderRemoteControls = () => {
    if (!isRemoteCliSource) {
      return null;
    }

    return (
      <div className="flex items-center justify-between gap-3 border-t border-gray-200 pt-2 mt-1 px-1">
        {renderRemoteModeToggle()}
        {renderRunButton()}
      </div>
    );
  };

  const renderRemoteAnalysisPanel = () => (
    <div className="flex flex-col gap-3 py-1">
      <div className="px-1 text-[11px] leading-snug">
        <div className="font-black uppercase tracking-wide text-[10px]">Analyze column</div>
        <ul className="mt-1 list-disc pl-4 space-y-0.5 font-medium">
          {remoteAnalysisSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      </div>

      {renderRemoteControls()}
    </div>
  );

  return (
    <div className="border-2 border-black rounded bg-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] w-[280px] max-w-[280px] flex flex-col pointer-events-auto font-sans">
      <div className="bg-gray-100 p-2 border-b-2 border-black flex justify-between items-center gap-2">
        <div className="flex flex-col mr-auto">
          <span className="font-black uppercase tracking-wider text-xs">{columnName}</span>
          <span
            className={`font-mono text-[10px] ${
              getColumnTypeColor(type)
                ? `px-1 rounded-none text-black ${getColumnTypeColor(type)} w-fit`
                : "text-gray-500"
            }`}
          >
            {type}
          </span>
        </div>

        {visibleStats?.distinctCount !== undefined && (
          <div className="bg-white border text-black border-black px-1.5 py-0.5 rounded text-[10px] font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] whitespace-nowrap">
            {visibleStats.distinctCount} distinct
          </div>
        )}

        {nullPct && (
          <div className="bg-white border text-black border-black px-1.5 py-0.5 rounded text-[10px] font-bold shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] whitespace-nowrap">
            {nullPct} null
          </div>
        )}
      </div>

      <div className="p-2 bg-white flex flex-col justify-center min-h-[60px]">
        {loading && (!isRemoteCliSource || !visibleStats) ? (
          isRemoteCliSource ? (
            renderRemoteAnalysisPanel()
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col items-center justify-center space-y-2 h-[120px]">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-black"></div>
                <span className="text-[10px] text-gray-400 font-mono">Loading stats...</span>
              </div>
            </div>
          )
        ) : showRemoteAnalysisGate ? (
          renderRemoteAnalysisPanel()
        ) : visibleStats?.error ? (
          <div className="flex flex-col gap-3">
            <div className="text-red-500 text-xs font-bold text-center py-4">{visibleStats.error}</div>

            {renderRemoteControls()}
          </div>
        ) : (
          <div className="flex flex-col gap-2 w-full">
            {(visibleStats?.type === "numeric" || visibleStats?.type === "temporal") && (
              <div className="flex flex-col gap-2">
                {visibleStats.histogram && visibleStats.histogram.length > 0 && (
                  <div className="w-full pt-2">
                    {(() => {
                      const maxCount = Math.max(...visibleStats.histogram.map((b) => b.count));
                      const formatter = new Intl.NumberFormat("en-US", {
                        notation: "compact",
                        maximumSignificantDigits: 3,
                      });
                      const formatCompactNumber = (num: number) => formatter.format(num);

                      const isTemporal = visibleStats.type === "temporal";
                      const formatDate = (val: any) => {
                        if (!val) return "";
                        const d = new Date(val);
                        if (isNaN(d.getTime())) return String(val);
                        return d.toISOString().split("T")[0];
                      };

                      let areaPath = "";
                      if (isTemporal && visibleStats.histogram.length > 1) {
                        const points = visibleStats.histogram
                          .map((bin, i) => {
                            const x = (i / (visibleStats.histogram!.length - 1)) * 100;
                            const y = 100 - (bin.count / maxCount) * 100;
                            return `${x},${y}`;
                          })
                          .join(" ");
                        areaPath = `M 0,100 L ${points} L 100,100 Z`;
                      }

                      return (
                        <div className="flex gap-1 h-[60px]">
                          {isTemporal && (
                            <div className="flex flex-col justify-between text-[8px] font-mono text-gray-400 h-full border-r border-gray-200 pr-1 min-w-[20px] text-right select-none">
                              <span>{formatCompactNumber(maxCount)}</span>
                              <span>0</span>
                            </div>
                          )}

                          <div className="flex-1 h-full flex items-end justify-between gap-px relative">
                            {isTemporal && visibleStats.histogram.length > 1 && (
                              <svg
                                className="absolute inset-0 w-full h-full pointer-events-none z-0"
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                              >
                                <path
                                  d={areaPath}
                                  className="fill-yellow-300 stroke-black stroke-[0.5] vector-effect-non-scaling-stroke"
                                />
                              </svg>
                            )}

                            {visibleStats.histogram.map((bin, i) => {
                              const startStr = isTemporal ? formatDate(bin.start) : bin.start.toFixed(1);
                              const endStr = isTemporal ? formatDate(bin.end) : bin.end.toFixed(1);
                              const rangeLabel = startStr === endStr ? startStr : `${startStr} - ${endStr}`;

                              return (
                                <div
                                  key={i}
                                  className={`flex-1 h-full flex items-end relative group cursor-crosshair px-[1px] z-10 ${isTemporal ? "" : ""}`}
                                >
                                  <div
                                    className={`w-full relative transition-colors ${
                                      isTemporal
                                        ? "bg-transparent group-hover:bg-black/5"
                                        : "bg-yellow-300 border border-black group-hover:bg-yellow-400"
                                    }`}
                                    style={{ height: `${Math.max((bin.count / maxCount) * 100, 2)}%` }}
                                  >
                                    {!isTemporal && (
                                      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-0.5 text-[8px] font-mono leading-none tracking-tighter text-gray-500 font-bold">
                                        {formatCompactNumber(bin.count)}
                                      </span>
                                    )}
                                  </div>

                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 hidden group-hover:block z-50 pointer-events-none">
                                    <div className="bg-white border border-black p-1 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] text-[10px] whitespace-nowrap rounded">
                                      <div className="font-bold">
                                        <span className="text-gray-500 font-normal mr-1">Range:</span>
                                        {rangeLabel}
                                      </div>
                                      <div className="text-gray-500">
                                        Count: <span className="text-black font-bold">{bin.count}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                <div className="flex justify-between text-[10px] font-mono text-gray-500 border-t border-gray-300 pt-1 mt-1">
                  <span>
                    {visibleStats.type === "temporal"
                      ? visibleStats.min
                        ? String(new Date(visibleStats.min).toISOString().split("T")[0])
                        : "N/A"
                      : visibleStats.min !== null
                        ? Number(visibleStats.min).toFixed(2)
                        : "N/A"}
                  </span>
                  <span>
                    {visibleStats.type === "temporal"
                      ? visibleStats.max
                        ? String(new Date(visibleStats.max).toISOString().split("T")[0])
                        : "N/A"
                      : visibleStats.max !== null
                        ? Number(visibleStats.max).toFixed(2)
                        : "N/A"}
                  </span>
                </div>
              </div>
            )}

            {visibleStats?.type === "text" && visibleStats.topValues && (
              <div className="flex flex-col gap-1 w-full -ml-1">
                {(() => {
                  const maxVal = Math.max(...visibleStats.topValues.map((v) => v.count));
                  return visibleStats.topValues.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs h-5 w-full">
                      <div
                        className={`w-[80px] shrink-0 font-mono text-xs truncate text-left ${item.isOther ? "italic text-gray-500" : ""}`}
                        title={String(item.value)}
                      >
                        {String(item.value)}
                      </div>

                      <div className="flex-1 flex items-center h-full">
                        <div className="flex-1 h-3 bg-gray-100 mr-2">
                          <div
                            style={{ width: `${(item.count / maxVal) * 100}%` }}
                            className="h-full bg-yellow-300 border-2 border-black transition-all duration-300"
                          />
                        </div>
                        <span className="font-bold font-mono text-[10px] w-8 text-right">{item.count}</span>
                      </div>
                    </div>
                  ));
                })()}
              </div>
            )}

            {visibleStats?.type === "text" && (!visibleStats.topValues || visibleStats.topValues.length === 0) && (
              <div className="text-xs text-gray-400 italic text-center py-2">No data distribution available</div>
            )}
            {visibleStats?.type === "other" && (
              <div className="text-xs text-gray-400 italic text-center py-2">No stats available for this type</div>
            )}

            {renderRemoteControls()}
          </div>
        )}
      </div>
    </div>
  );
};
