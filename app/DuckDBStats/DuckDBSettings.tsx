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
type Settings = {
  memory: Memory;
  duckdbThreads?: number | null;
  availableCPUs?: number;
  enforcementOverride: string;
  availableMiB: number;
};

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

function memoryBudget(memory: Memory, availableMiB: number, capRequired: boolean) {
  const percent = hasLimit(memory) || capRequired ? (memory.limit_percent ?? 50) : 100;
  return memory.limit_mib ?? Math.max(1, Math.floor(((availableMiB || 8192) * percent) / 100));
}

export function DuckDBSettings() {
  const { stats } = useDuckDBStats();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Memory>({});
  const [draftThreads, setDraftThreads] = useState<number | null>();
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

  const running = !!stats?.pid;
  const availableCPUs = settings?.availableCPUs ?? stats?.duckdbThreadLimit ?? 1;
  const savedThreads = settings?.duckdbThreads ?? null;
  const requestedThreads = draftThreads === undefined ? savedThreads : draftThreads;
  const defaultThreads = (savedThreads === null ? stats?.duckdbThreadLimit : undefined) ?? availableCPUs;
  const selectedThreads = requestedThreads ?? defaultThreads;
  const maxThreads = Math.max(availableCPUs, savedThreads ?? 0, selectedThreads);
  const dirty =
    settings && (JSON.stringify(settings.memory) !== JSON.stringify(draft) || requestedThreads !== savedThreads);
  const capRequired = settings?.enforcementOverride === "required";
  const limited = hasLimit(draft) || capRequired;
  const available = settings?.availableMiB || 0;
  const savedBudget = memoryBudget(settings?.memory ?? {}, available, capRequired);
  const requested = memoryBudget(draft, available, capRequired);
  const maximum = Math.max(available || 65536, savedBudget, requested);
  const stops = new Set([Math.min(256, maximum), maximum, savedBudget, requested]);
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
          body: JSON.stringify({ ...draft, duckdbThreads: requestedThreads }),
        });
        const data: Settings = await response.json();
        setSettings(data);
        setDraft(data.memory);
        setDraftThreads(undefined);
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
    <form
      className="duckdb-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void restartWorker();
      }}
    >
      <fieldset disabled={!!busy}>
        {settings && (
          <>
            <div className="duckdb-setting-heading">
              <label htmlFor="duckdb-budget">
                <strong>Memory</strong>
              </label>
              <output htmlFor="duckdb-budget">{amount(requested)}</output>
            </div>
            <input
              className="kavla-knob-slider"
              id="duckdb-budget"
              type="range"
              min={0}
              max={amounts.length - 1}
              step={1}
              value={amounts.indexOf(requested)}
              aria-valuetext={amount(requested)}
              onChange={(event) => chooseLimit(amounts[event.currentTarget.valueAsNumber])}
            />
            <div className="kavla-knob-range">
              <span>{amount(amounts[0])}</span>
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
                    {{ auto: "If available", required: "Required", off: "Off" }[mode]}
                  </button>
                ))}
              </div>
            </div>
            <label className="duckdb-setting-heading">
              Swap limit (MiB)
              <input
                className="kavla-knob-input duckdb-setting-number"
                type="number"
                min={0}
                step={1}
                value={draft.swap_limit_mib ?? ""}
                placeholder={limited ? "0" : "System"}
                onChange={(event) =>
                  edit({ ...draft, swap_limit_mib: event.target.value === "" ? undefined : event.target.valueAsNumber })
                }
              />
            </label>
            {settings.enforcementOverride && <small>CLI hard cap: {settings.enforcementOverride}</small>}
            <div className="duckdb-setting-heading">
              <label htmlFor="duckdb-threads">
                <strong>DuckDB threads</strong>
              </label>
              <output htmlFor="duckdb-threads">{selectedThreads}</output>
            </div>
            <input
              className="kavla-knob-slider"
              id="duckdb-threads"
              type="range"
              min={1}
              max={maxThreads}
              step={1}
              value={selectedThreads}
              onChange={(event) => {
                setDraftThreads(event.currentTarget.valueAsNumber);
                setError("");
                setMessage("");
              }}
            />
            <div className="kavla-knob-range">
              <span>1</span>
              <span>{maxThreads}</span>
            </div>
          </>
        )}
        {!settings && !error && <span>Loading…</span>}
        <div className="duckdb-actions">
          <button type="submit">
            <RotateCw size={13} />
            {dirty ? (running ? "Save & restart" : "Save & start") : running ? "Restart worker" : "Start worker"}
          </button>
          {settings && (
            <button
              type="button"
              onClick={() => {
                edit({});
                setDraftThreads(null);
              }}
            >
              Reset
            </button>
          )}
        </div>
      </fieldset>
      {(busy || message) && <span role="status">{busy || message}</span>}
      {error && <span role="alert">{error}</span>}
    </form>
  );
}
