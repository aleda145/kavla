import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Download, History, Loader2, RotateCcw, X } from "lucide-react";
import { canvasApiURL } from "../canvasConnection";
import { listCanvasSnapshots, setCanvasHistoryLimit, type CanvasSnapshot } from "./localSession";

const reasonLabels: Record<CanvasSnapshot["reason"], string> = {
  opened: "Opened canvas",
  automatic: "Autosave",
  save: "Save",
  "before-restore": "Before restoration",
};

export function LocalHistoryDialog({
  documentName,
  onClose,
  onRestore,
}: {
  documentName: string;
  onClose: () => void;
  onRestore: (snapshotId: string) => Promise<void>;
}) {
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(5);
  const [limitInput, setLimitInput] = useState("5");
  const [savingLimit, setSavingLimit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const savingLimitRef = useRef<Promise<boolean> | null>(null);
  const selected = snapshots.find((snapshot) => snapshot.id === selectedId);
  const busy = restoring || savingLimit;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listCanvasSnapshots()
      .then((history) => {
        if (cancelled) return;
        setSnapshots(history.snapshots);
        setSelectedId(history.snapshots[0]?.id ?? null);
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
  }, []);

  const restore = async () => {
    if (!selectedId || busy) return;
    setRestoring(true);
    setError(null);
    try {
      await onRestore(selectedId);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestoring(false);
    }
  };

  const saveLimit = (): Promise<boolean> => {
    if (savingLimitRef.current) return savingLimitRef.current;
    if (loading) return Promise.resolve(true);
    const limit = Number(limitInput);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      setError("Enter a whole number of saves, at least 1.");
      return Promise.resolve(false);
    }
    if (limit === historyLimit) return Promise.resolve(true);
    const pending = (async () => {
      setSavingLimit(true);
      setError(null);
      try {
        const history = await setCanvasHistoryLimit(limit);
        setSnapshots(history.snapshots);
        setHistoryLimit(history.limit);
        setLimitInput(String(history.limit));
        setSelectedId((id) =>
          history.snapshots.some((snapshot) => snapshot.id === id) ? id : (history.snapshots[0]?.id ?? null)
        );
        return true;
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        savingLimitRef.current = null;
        setSavingLimit(false);
      }
    })();
    savingLimitRef.current = pending;
    return pending;
  };

  const closeHistory = async () => {
    if (restoring) return;
    if (await saveLimit()) onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-900/30 p-5"
      style={{ zIndex: 1_000_000, pointerEvents: "all" }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !restoring) void closeHistory();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !restoring) void closeHistory();
        if (event.key !== "Tab") return;
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), a[href]"
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
        aria-labelledby="canvas-history-title"
        className="flex max-h-[85vh] w-[560px] max-w-full flex-col overflow-hidden rounded-xl border-[3px] border-black bg-white text-black shadow-[6px_6px_0_0_#000] outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b-[3px] border-black bg-orange-100 px-4 py-3">
          <h2 id="canvas-history-title" className="flex items-center gap-2 font-black">
            <History size={18} /> History · {documentName}
          </h2>
          <button type="button" aria-label="Close history" disabled={restoring} onClick={() => void closeHistory()}>
            <X size={20} />
          </button>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 p-6">
            <Loader2 className="animate-spin" size={18} /> Loading history…
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {snapshots.length === 0 && <p className="p-4 text-sm">No snapshots yet.</p>}
            {snapshots.map((snapshot) => (
              <button
                type="button"
                key={snapshot.id}
                disabled={busy}
                aria-pressed={selectedId === snapshot.id}
                className={`block w-full border-b border-slate-200 p-3 text-left text-xs hover:bg-blue-50 ${selectedId === snapshot.id ? "bg-blue-100" : "bg-white"}`}
                onClick={() => {
                  if (snapshot.id !== selectedId) {
                    setError(null);
                    setSelectedId(snapshot.id);
                  }
                }}
              >
                <time className="block font-bold" dateTime={snapshot.createdAt}>
                  {formatSnapshotDate(snapshot.createdAt)}
                </time>
                <span className="mt-1 block text-slate-600">
                  {reasonLabels[snapshot.reason]} · {snapshot.shapeCount.toLocaleString()}{" "}
                  {snapshot.shapeCount === 1 ? "shape" : "shapes"} · {formatSnapshotSize(snapshot.size)}
                </span>
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mx-4 my-2 rounded border-2 border-black bg-red-100 p-3 text-xs">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-black p-4">
          <label className="mr-auto flex items-center gap-2 text-xs font-bold">
            Saves to keep
            <input
              aria-label="Number of saves to keep"
              type="number"
              min={1}
              step={1}
              value={limitInput}
              disabled={loading || busy}
              onChange={(event) => setLimitInput(event.currentTarget.value)}
              onBlur={() => void saveLimit()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
              className="w-16 rounded border-2 border-black bg-white px-2 py-2 text-xs disabled:opacity-40"
            />
            {savingLimit && <Loader2 aria-label="Saving history limit" className="animate-spin" size={14} />}
          </label>
          {selected && (
            <a
              style={buttonStyle}
              download={`${documentName}-${selected.id}.kavla`}
              href={canvasApiURL(`/api/session/snapshots/${encodeURIComponent(selected.id)}/download`)}
            >
              <Download size={14} /> Download
            </a>
          )}
          <button
            type="button"
            disabled={!selectedId || busy}
            onClick={() => void restore()}
            style={{ ...buttonStyle, background: "#dcfce7" }}
            className="disabled:opacity-40"
          >
            {restoring ? <Loader2 className="animate-spin" size={14} /> : <RotateCcw size={14} />}
            {restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function formatSnapshotDate(timestamp: string): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSnapshotSize(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(size / 1024)).toLocaleString()} KB`;
}

const buttonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "2px solid #000",
  borderRadius: 7,
  background: "white",
  padding: "8px 12px",
  fontSize: 12,
  fontWeight: 800,
  color: "black",
  cursor: "pointer",
  boxShadow: "2px 2px 0 0 rgba(0,0,0,0.2)",
  textDecoration: "none",
};
