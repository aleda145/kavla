import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { backendRequest } from "../client/backendCompute";
import { useDuckDBStats } from "./useDuckDBStats";
import "../Knob/knob.css";
import "./settings.css";

const endpoint = "/api/session/compute-settings";
type Memory = {
  enforcement?: "auto" | "required" | "off";
  limit_mib?: number;
  limit_percent?: number;
  duckdb_percent_of_limit?: number;
  swap_limit_mib?: number;
};
type Settings = { memory: Memory; enforcementOverride: string; availableMiB: number };

function amount(mib: number) {
  return mib < 1024 ? `${mib} MiB` : `${Number((mib / 1024).toFixed(2))} GiB`;
}

function hasLimit(memory: Memory) {
  return (
    memory.limit_mib !== undefined ||
    memory.limit_percent !== undefined ||
    memory.duckdb_percent_of_limit !== undefined ||
    memory.swap_limit_mib !== undefined ||
    memory.enforcement === "required"
  );
}

export function DuckDBSettings() {
  const { stats } = useDuckDBStats();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Memory>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await backendRequest(endpoint, { signal: controller.signal });
        const data: Settings = await response.json();
        if (!controller.signal.aborted) {
          setSettings(data);
          setDraft(data.memory);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  const dirty = settings && JSON.stringify(settings.memory) !== JSON.stringify(draft);
  const running = !!stats?.pid;
  const limited = hasLimit(draft);
  const available = settings?.availableMiB || 0;
  const maximum = Math.max(available || 65536, draft.limit_mib || 0);
  const requested =
    draft.limit_mib ?? Math.max(1, Math.floor(((available || 8192) * (draft.limit_percent ?? 50)) / 100));
  const stops = new Set([Math.min(256, maximum), maximum, requested]);
  for (let mib = 256; mib < maximum; mib *= 2) {
    stops.add(mib);
    if (mib * 1.5 < maximum) stops.add(mib * 1.5);
  }
  const amounts = Array.from(stops).sort((a, b) => a - b);

  function edit(memory: Memory) {
    setDraft(memory);
    setError("");
    setMessage("");
  }

  function chooseLimit(mib: number) {
    const next = { ...draft, limit_mib: mib };
    delete next.limit_percent;
    delete next.duckdb_percent_of_limit;
    edit(next);
  }

  async function restartWorker() {
    setError("");
    setMessage("");
    try {
      if (dirty) {
        setBusy("Saving…");
        const response = await backendRequest(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        });
        const data: Settings = await response.json();
        setSettings(data);
        setDraft(data.memory);
        setMessage("Saved for next start.");
      }
      setBusy(stats?.state === "busy" ? "Waiting for current work…" : running ? "Restarting…" : "Starting…");
      await backendRequest("/api/session/compute-restart", { method: "POST" });
      setMessage("Worker ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="duckdb-settings">
      <fieldset disabled={!!busy}>
        {settings && (
          <>
            <div className="duckdb-setting-heading">
              <label htmlFor="duckdb-budget">
                <strong>Memory</strong> <small>All canvases</small>
              </label>
              <output htmlFor="duckdb-budget">
                {!limited ? "Auto" : draft.limit_mib === undefined && !available ? "System-based" : amount(requested)}
              </output>
            </div>
            <input
              className="kavla-knob-slider"
              id="duckdb-budget"
              type="range"
              min={0}
              max={amounts.length}
              value={limited ? amounts.indexOf(requested) + 1 : 0}
              aria-valuetext={!limited ? "Automatic" : amount(requested)}
              onChange={(event) => {
                const index = event.currentTarget.valueAsNumber;
                if (index === 0) edit({});
                else chooseLimit(amounts[index - 1]);
              }}
            />
            <div className="kavla-knob-range">
              <span>Auto</span>
              <span>{amount(maximum)}</span>
            </div>
            <div className="duckdb-setting-heading">
              <span id="duckdb-cap-label">Linux hard cap</span>
              <div className="duckdb-cap-options" role="group" aria-labelledby="duckdb-cap-label">
                {(["auto", "required", "off"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    disabled={!!settings.enforcementOverride}
                    aria-pressed={(settings.enforcementOverride || draft.enforcement || "auto") === mode}
                    onClick={() => edit({ ...draft, enforcement: mode })}
                  >
                    {{ auto: "Auto", required: "Required", off: "Off" }[mode]}
                  </button>
                ))}
              </div>
            </div>
            <label className="duckdb-setting-heading">
              Swap limit (MiB)
              <input
                className="kavla-knob-input duckdb-swap"
                type="number"
                min={0}
                step={1}
                value={draft.swap_limit_mib ?? ""}
                placeholder={limited ? "0" : "Auto"}
                onChange={(event) =>
                  edit({ ...draft, swap_limit_mib: event.target.value === "" ? undefined : event.target.valueAsNumber })
                }
              />
            </label>
            {settings.enforcementOverride && <small>CLI hard cap: {settings.enforcementOverride}</small>}
          </>
        )}
        {!settings && !error && <span>Loading…</span>}
        <div className="duckdb-actions">
          <button type="button" onClick={() => void restartWorker()}>
            <RotateCw size={13} />
            {dirty ? (running ? "Save & restart" : "Save & start") : running ? "Restart worker" : "Start worker"}
          </button>
        </div>
      </fieldset>
      {(busy || message) && <span role="status">{busy || message}</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
