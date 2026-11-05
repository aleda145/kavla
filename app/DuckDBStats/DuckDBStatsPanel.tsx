import type { ReactNode } from "react";
import { siDuckdb } from "simple-icons";
import { useCliStatus } from "../client/localServer/runtimeStore";
import { useDuckDBStats } from "./useDuckDBStats";

function bytes(value: number | undefined) {
  if (value === undefined) return "Unavailable";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

export function DuckDBStatsPanel({ action }: { action?: ReactNode }) {
  const { stats, error } = useDuckDBStats();
  const connected = useCliStatus();
  const state = !connected
    ? "Disconnected"
    : error
      ? "Unavailable"
      : !stats
        ? "Loading…"
        : {
            standby: "Sleeping",
            starting: "Starting…",
            stopped: "Stopped",
            idle: "Idle",
            busy: "Working",
          }[stats.state];
  const seconds = Math.floor(stats?.uptimeSeconds ?? 0);
  const rows = stats?.pid
    ? [
        ["Process ID", String(stats.pid)],
        ["Uptime", `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`],
        ["Process memory (RSS)", bytes(stats.residentBytes)],
        ...(stats.peakResidentBytes !== undefined ? [["Peak process memory", bytes(stats.peakResidentBytes)]] : []),
        ...(stats.swapBytes !== undefined ? [["Process swap", bytes(stats.swapBytes)]] : []),
        ...(stats.threads !== undefined ? [["Threads", String(stats.threads)]] : []),
        ["DuckDB memory budget", bytes(stats.duckdbLimitBytes)],
        ["Shared compute cap", stats.sharedLimitBytes ? bytes(stats.sharedLimitBytes) : "Not enforced"],
      ]
    : [];
  return (
    <div style={{ background: "#fff", color: "#000", fontFamily: "Inter, sans-serif", fontSize: 12, height: "100%" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "#fef08a",
          borderBottom: "2px solid #000",
          padding: "10px 12px",
        }}
      >
        <svg aria-hidden viewBox="0 0 24 24" width={18} height={18} fill="currentColor">
          <path d={siDuckdb.path} />
        </svg>
        <strong style={{ fontWeight: 850 }}>DuckDB</strong>
        <span role="status" style={{ fontSize: 11 }}>
          {state}
        </span>
        {action && <div style={{ marginLeft: "auto" }}>{action}</div>}
      </div>
      <div style={{ padding: 12 }}>
        {connected && !error && stats && (
          <>
            {rows.length > 0 && (
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "1fr auto", gap: "9px 12px" }}>
                {rows.map(([label, value]) => (
                  <div key={label} style={{ display: "contents" }}>
                    <dt style={{ color: "#475569" }}>{label}</dt>
                    <dd style={{ margin: 0, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {stats.error && (
              <p role="alert" style={{ color: "#b91c1c", overflowWrap: "anywhere" }}>
                {stats.error}
              </p>
            )}
            {stats.metricsError && <p style={{ color: "#b91c1c", overflowWrap: "anywhere" }}>{stats.metricsError}</p>}
          </>
        )}
        {connected && error && (
          <p role="alert" style={{ margin: 0, color: "#b91c1c" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
