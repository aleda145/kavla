import { Database, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCliSources } from "../client/useLocalServer";

export interface StoreDestination {
  sourceName: string;
  schemaName: string;
  tableName: string;
}

interface StoreQueryDialogProps {
  defaultTableName: string;
  onClose: () => void;
  onStore: (destination: StoreDestination) => Promise<void>;
}

const inputClass = "w-full rounded border-2 border-black bg-white px-3 py-2 text-sm disabled:opacity-50";
const buttonClass =
  "h-9 px-3 rounded border-2 border-black font-bold text-xs flex items-center justify-center gap-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

export function StoreQueryDialog({ defaultTableName, onClose, onStore }: StoreQueryDialogProps) {
  const sources = useCliSources();
  const [sourceName, setSourceName] = useState(
    () =>
      sources.find((source) => source.builtin && source.available !== false)?.name ??
      sources.find((source) => source.available !== false)?.name ??
      ""
  );
  const source = sources.find((candidate) => candidate.name === sourceName);
  const [schemaName, setSchemaName] = useState(
    source?.type === "postgres" ? "public" : source?.type === "duckdb" ? "main" : ""
  );
  const [tableName, setTableName] = useState(defaultTableName);
  const [storing, setStoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const isDirectory = source?.type === "directory";
  const needsSchema = source && !source.builtin && !isDirectory;
  const validName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const canStore =
    source &&
    source.available !== false &&
    validName.test(tableName.trim()) &&
    (!needsSchema || validName.test(schemaName.trim()));

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      className="backdrop:bg-black/30"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy.current) onClose();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      style={{
        margin: "auto",
        padding: 0,
        width: "min(440px, calc(100vw - 40px))",
        maxHeight: "calc(100vh - 40px)",
        overflowY: "auto",
        border: "3px solid #000",
        borderRadius: 12,
        boxShadow: "6px 6px 0 #000",
        background: "#fff",
        color: "#000",
        fontFamily: "Inter, sans-serif",
        pointerEvents: "all",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 16px",
          background: "#dbeafe",
          borderBottom: "3px solid #000",
        }}
      >
        <Database size={20} />
        <h2 id={`${id}-title`} style={{ flex: 1, margin: 0, fontSize: 16, fontWeight: 900 }}>
          Store result
        </h2>
        <button
          type="button"
          aria-label="Close Store dialog"
          disabled={storing}
          onClick={onClose}
          className="cursor-pointer disabled:opacity-50"
        >
          <X size={20} />
        </button>
      </div>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canStore || busy.current) return;
          busy.current = true;
          setStoring(true);
          setError(null);
          try {
            await onStore({
              sourceName,
              schemaName: source?.builtin ? "main" : schemaName.trim(),
              tableName: tableName.trim(),
            });
            onClose();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            busy.current = false;
            setStoring(false);
          }
        }}
        style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}
      >
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
          Run the current query and store all rows as a new table. A connected data source will appear on the canvas.
        </p>
        <label className="flex flex-col gap-1 text-xs font-bold">
          Source
          <select
            autoFocus
            value={sourceName}
            disabled={storing}
            className={inputClass}
            onChange={(event) => {
              const selected = sources.find((candidate) => candidate.name === event.target.value);
              setSourceName(event.target.value);
              setSchemaName(selected?.type === "postgres" ? "public" : selected?.type === "duckdb" ? "main" : "");
              setError(null);
            }}
          >
            {!sourceName && <option value="">Choose a source</option>}
            {sources.map((candidate) => (
              <option key={candidate.name} value={candidate.name} disabled={candidate.available === false}>
                {candidate.name}
                {candidate.builtin ? " (this document)" : ` (${candidate.type})`}
                {candidate.available === false ? " — unavailable" : ""}
              </option>
            ))}
          </select>
        </label>
        {needsSchema && (
          <label className="flex flex-col gap-1 text-xs font-bold">
            {source.type === "bigquery" ? "Dataset" : "Schema"}
            <input
              required
              value={schemaName}
              onChange={(event) => setSchemaName(event.target.value)}
              disabled={storing}
              className={inputClass}
              placeholder={source.type === "bigquery" ? "Existing dataset" : "Existing schema"}
              pattern="[a-zA-Z_][a-zA-Z0-9_]*"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs font-bold">
          Table name
          <input
            required
            value={tableName}
            onChange={(event) => setTableName(event.target.value)}
            disabled={storing}
            className={inputClass}
            pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          />
          <span className="font-normal text-gray-600">
            Letters, numbers, and underscores. Existing tables are never replaced.
          </span>
        </label>
        {source?.builtin && (
          <p className="m-0 text-xs text-gray-600">Stored with this document when you save the .kavla file.</p>
        )}
        {isDirectory && (
          <p className="m-0 text-xs text-gray-600">
            Creates {tableName || "table"}.parquet in this source’s directory.
          </p>
        )}
        {error && (
          <div role="alert" className="rounded border-2 border-red-700 bg-red-50 p-3 text-sm break-words">
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={storing} className={`${buttonClass} bg-white`}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canStore || storing}
            className={`${buttonClass} bg-blue-100 hover:bg-blue-200`}
          >
            {storing ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            {storing ? "Storing…" : "Store"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body
  );
}
