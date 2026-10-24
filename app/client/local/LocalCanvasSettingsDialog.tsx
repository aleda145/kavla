import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { JustIconsToggle } from "../justIcons";
import { Loader2, Settings, X } from "lucide-react";
import { useCliStatus } from "../localServer/runtimeStore";
import { listCanvasSnapshots, setCanvasHistoryLimit } from "./localSession";

export function LocalCanvasSettingsDialog({ onClose }: { onClose: () => void }) {
  const cliConnected = useCliStatus();
  const dialogRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const [historyLimit, setHistoryLimit] = useState<number | null>(null);
  const [limitInput, setLimitInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    if (!cliConnected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listCanvasSnapshots()
      .then((history) => {
        if (cancelled) return;
        setHistoryLimit(history.limit);
        setLimitInput(String(history.limit));
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cliConnected]);

  const save = (): Promise<boolean> => {
    if (savingRef.current) return savingRef.current;
    if (loading || historyLimit === null) return Promise.resolve(true);
    const limit = Number(limitInput);
    if (limit === historyLimit) {
      setError(null);
      return Promise.resolve(true);
    }
    if (!cliConnected) {
      setError("CLI disconnected. Changes haven’t been saved.");
      return Promise.resolve(false);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      setError("Enter a whole number of saves, at least 1.");
      return Promise.resolve(false);
    }
    const pending = (async () => {
      setSaving(true);
      setError(null);
      try {
        const history = await setCanvasHistoryLimit(limit);
        setHistoryLimit(history.limit);
        setLimitInput(String(history.limit));
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        savingRef.current = null;
        setSaving(false);
      }
    })();
    savingRef.current = pending;
    return pending;
  };

  const closeSettings = async () => {
    if (await save()) onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-900/30 p-5"
      style={{ zIndex: 1_000_000, pointerEvents: "all", fontFamily: "Inter, sans-serif" }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) void closeSettings();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          void closeSettings();
        }
        if (event.key !== "Tab") return;
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)"
        );
        if (!elements?.length) {
          event.preventDefault();
          return;
        }
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-settings-title"
        className="flex max-h-[85vh] w-[440px] max-w-full flex-col overflow-hidden rounded-xl border-2 border-black bg-white text-black shadow-[4px_4px_0_0_#000] outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b-2 border-black bg-white px-5 py-4">
          <h2 id="canvas-settings-title" className="flex items-center gap-2 font-black">
            <Settings size={18} aria-hidden="true" /> Canvas settings
          </h2>
          <button
            type="button"
            aria-label="Close canvas settings"
            disabled={saving}
            onClick={() => void closeSettings()}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-black disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-5">
          <div className="mb-5">
            <JustIconsToggle />
          </div>
          {!cliConnected ? (
            <p className="text-sm">CLI disconnected.</p>
          ) : loading ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 size={16} className="animate-spin" /> Loading settings…
            </p>
          ) : historyLimit !== null ? (
            <section aria-labelledby="canvas-settings-history">
              <h3 id="canvas-settings-history" className="mb-3 text-xs font-black uppercase tracking-wide">
                History
              </h3>
              <label className="flex items-center justify-between gap-4 text-sm font-bold">
                Saves to keep
                <input
                  type="number"
                  min={1}
                  step={1}
                  required
                  value={limitInput}
                  disabled={saving}
                  onChange={(event) => setLimitInput(event.currentTarget.value)}
                  onBlur={() => void save()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-20 rounded border-2 border-black bg-white px-2 py-2 text-sm disabled:opacity-40"
                />
                {saving ? <Loader2 aria-label="Saving history limit" size={14} className="animate-spin" /> : null}
              </label>
            </section>
          ) : null}
          {error ? (
            <p role="alert" className="mt-4 rounded border-2 border-black bg-red-100 p-3 text-xs">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
