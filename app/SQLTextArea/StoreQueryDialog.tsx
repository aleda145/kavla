import { Database, Loader2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCliSources } from "../client/useLocalServer";
import { backendRequest } from "../client/backendCompute";
import { CliSourceIcon, getCliSourceAppearance } from "../DataSource/CliSourcesList";

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

const inputClass =
  "w-full min-w-0 rounded-[7px] border-2 border-black bg-white px-2.5 py-2 text-[13px] font-bold disabled:opacity-50";
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
  const [schemas, setSchemas] = useState<string[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
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

  useEffect(() => {
    setSchemas([]);
    setSchemaError(null);
    if (!needsSchema || source?.available === false) {
      setLoadingSchemas(false);
      return;
    }
    const controller = new AbortController();
    setLoadingSchemas(true);
    void backendRequest(`/api/cli/sources/${encodeURIComponent(sourceName)}/schemas`, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as { schemas: string[] };
        if (!controller.signal.aborted) setSchemas(result.schemas);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setSchemaError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingSchemas(false);
      });
    return () => controller.abort();
  }, [sourceName, needsSchema, source?.available]);

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
        width: "min(520px, calc(100vw - 40px))",
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
          padding: "11px 14px",
          background: "#dbeafe",
          borderBottom: "3px solid #000",
        }}
      >
        <Database size={18} strokeWidth={2.7} />
        <h2 id={`${id}-title`} style={{ flex: 1, margin: 0, fontSize: 14, fontWeight: 900 }}>
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
        <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }} disabled={storing}>
          <legend className="mb-2 text-[11px] font-black">SOURCE</legend>
          <div
            style={{
              background: "#f8fafc",
              border: "2px solid #000",
              borderRadius: 8,
              maxHeight: 240,
              overflowY: "auto",
            }}
          >
            {sources.map((candidate) => {
              const appearance = getCliSourceAppearance(candidate);
              const selected = candidate.name === sourceName;
              const unavailable = candidate.available === false;
              return (
                <label
                  key={candidate.name}
                  className="hover:bg-blue-50"
                  title={unavailable ? (candidate.error ?? "Source unavailable") : candidate.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "10px 11px",
                    borderBottom: "1px solid #cbd5e1",
                    cursor: storing || unavailable ? "not-allowed" : "pointer",
                    backgroundColor: selected ? "#eff6ff" : undefined,
                    opacity: unavailable ? 0.45 : 1,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      width: 36,
                      height: 36,
                      padding: 6,
                      border: "2px solid #000",
                      borderRadius: 6,
                      backgroundColor: appearance.backgroundColor,
                    }}
                  >
                    <CliSourceIcon source={candidate} size={20} />
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                    <strong className="truncate text-[13px]">
                      {candidate.name === "uploaded_files" ? "Files" : candidate.name}
                    </strong>
                    <span className="text-[11px] text-slate-600">
                      {candidate.type}
                      {unavailable ? " · Unavailable" : ""}
                    </span>
                  </span>
                  <input
                    type="radio"
                    name={`${id}-source`}
                    value={candidate.name}
                    checked={selected}
                    autoFocus={selected}
                    disabled={unavailable}
                    style={{ accentColor: "#000", width: 16, height: 16 }}
                    onChange={() => {
                      setSourceName(candidate.name);
                      setSchemaName(
                        candidate.type === "postgres" ? "public" : candidate.type === "duckdb" ? "main" : ""
                      );
                      setError(null);
                    }}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
        {needsSchema && (
          <label className="flex flex-col gap-1 text-[11px] font-black">
            <span className="flex items-center gap-2">
              {source.type === "bigquery" ? "DATASET" : "SCHEMA"}
              {loadingSchemas && <Loader2 size={12} className="animate-spin" aria-label="Loading schemas" />}
            </span>
            <input
              required
              value={schemaName}
              onChange={(event) => setSchemaName(event.target.value)}
              disabled={storing}
              className={inputClass}
              list={`${id}-schemas`}
              autoComplete="off"
              spellCheck={false}
              pattern="[a-zA-Z_][a-zA-Z0-9_]*"
            />
            <datalist id={`${id}-schemas`}>
              {schemas.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {schemaError && (
              <span role="alert" className="text-xs font-normal text-red-700">
                {schemaError}
              </span>
            )}
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11px] font-black">
          TABLE NAME
          <input
            required
            value={tableName}
            onChange={(event) => setTableName(event.target.value)}
            disabled={storing}
            className={inputClass}
            pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          />
        </label>
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
