import { AlertCircle, Check, Database, Loader2, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useCliSources } from "../client/useLocalServer";
import { backendRequest, withBackendActivity } from "../client/backendCompute";
import { CliSourceIcon, getCliSourceAppearance } from "../DataSource/CliSourcesList";
import { StoreSchemaSelect } from "./StoreSchemaSelect";

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
  const sortedSources = [...sources].sort((a, b) => {
    if (a.name === "uploaded_files") return -1;
    if (b.name === "uploaded_files") return 1;
    return a.name.localeCompare(b.name);
  });
  const [sourceName, setSourceName] = useState(
    () =>
      sources.find((source) => source.builtin && source.available !== false)?.name ??
      sources.find((source) => source.available !== false)?.name ??
      sources[0]?.name ??
      ""
  );
  const source = sources.find((candidate) => candidate.name === sourceName);
  const [schemaName, setSchemaName] = useState(
    source?.type === "postgres" ? "public" : source?.type === "duckdb" ? "main" : ""
  );
  const [tableName, setTableName] = useState(defaultTableName);
  const [storing, setStoring] = useState(false);
  const [createSchemaOpen, setCreateSchemaOpen] = useState(false);
  const [newSchemaName, setNewSchemaName] = useState("");
  const [creatingSchema, setCreatingSchema] = useState(false);
  const [schemaCreateError, setSchemaCreateError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceLoad, setSourceLoad] = useState<{
    sourceName: string;
    schemas: string[];
    error: string | null;
    loading: boolean;
  } | null>(null);
  const busy = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const tableNameInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const isBusy = storing || creatingSchema;
  const schemaLabel = source?.type === "bigquery" ? "Dataset" : "Schema";

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const isDirectory = source?.type === "directory";
  const needsSchema = source && !source.builtin && !isDirectory;
  const shouldLoadSource = Boolean(source && !source.builtin);
  const currentLoad = sourceLoad?.sourceName === sourceName ? sourceLoad : null;
  const loadingSource = shouldLoadSource && (!currentLoad || currentLoad.loading || source?.loading === true);
  const sourceError = currentLoad?.error ?? (!loadingSource ? source?.error : null);
  const schemas = currentLoad?.schemas ?? [];

  useEffect(() => {
    if (!shouldLoadSource) {
      setSourceLoad(null);
      return;
    }
    let active = true;
    setSourceLoad({ sourceName, schemas: [], error: null, loading: true });
    void backendRequest(`/api/cli/sources/${encodeURIComponent(sourceName)}/schemas`)
      .then(async (response) => {
        const result = (await response.json()) as { schemas: string[] };
        if (active) {
          setSourceLoad({ sourceName, schemas: result.schemas, error: null, loading: false });
          setSchemaName((current) => (result.schemas.includes(current) ? current : (result.schemas[0] ?? "")));
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setSourceLoad({
            sourceName,
            schemas: [],
            error: cause instanceof Error ? cause.message : String(cause),
            loading: false,
          });
        }
      });
    // Let initialization finish if the selection changes; cancelling it also stops the shared compute worker.
    return () => {
      active = false;
    };
  }, [sourceName, shouldLoadSource]);

  const validName = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const maxSchemaLength = source?.type === "postgres" ? 63 : source?.type === "bigquery" ? 1024 : undefined;
  const canCreateSchema =
    needsSchema &&
    !loadingSource &&
    !sourceError &&
    validName.test(newSchemaName.trim()) &&
    (maxSchemaLength === undefined || newSchemaName.trim().length <= maxSchemaLength);

  const handleCreateSchema = async () => {
    if (!canCreateSchema || busy.current) return;
    busy.current = true;
    setCreatingSchema(true);
    setSchemaCreateError(null);
    const name = newSchemaName.trim();
    try {
      const result = await withBackendActivity(async () => {
        const response = await backendRequest(`/api/cli/sources/${encodeURIComponent(sourceName)}/schemas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ schemaName: name }),
        });
        return (await response.json()) as { schemas: string[] };
      });
      if (!result.schemas.includes(name))
        throw new Error(`The new ${schemaLabel.toLowerCase()} is not visible yet. Refresh the source before storing.`);
      setSourceLoad({ sourceName, schemas: result.schemas, error: null, loading: false });
      setSchemaName(name);
      setCreateSchemaOpen(false);
      setNewSchemaName("");
      window.requestAnimationFrame(() => tableNameInput.current?.focus());
    } catch (cause) {
      setSchemaCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      setCreatingSchema(false);
    }
  };

  const canStore =
    source &&
    !isBusy &&
    !createSchemaOpen &&
    !loadingSource &&
    !sourceError &&
    validName.test(tableName.trim()) &&
    (!needsSchema || (validName.test(schemaName.trim()) && schemas.includes(schemaName.trim())));

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
        width: "min(680px, calc(100vw - 40px))",
        minHeight: "min(340px, calc(100vh - 40px))",
        maxHeight: "min(720px, calc(100vh - 40px))",
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
          disabled={isBusy}
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
        style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16 }}
      >
        <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }} disabled={isBusy}>
          <legend className="mb-2 text-[11px] font-black">SOURCE</legend>
          <div
            style={{
              backgroundColor: "#f8fafc",
              border: "2px solid #000",
              borderRadius: 8,
              minHeight: 220,
              maxHeight: 320,
              overflowY: "auto",
            }}
          >
            {sortedSources.map((candidate) => {
              const appearance = getCliSourceAppearance(candidate);
              const selected = candidate.name === sourceName;
              const loading = candidate.loading || (selected && loadingSource);
              const connectionError = selected ? sourceError : candidate.error;
              const label = candidate.name === "uploaded_files" ? "Files" : candidate.name;
              const title = loading
                ? `${label} · Connecting…`
                : connectionError
                  ? `${label}\n${connectionError}`
                  : `${label} (${candidate.type})`;
              return (
                <label
                  key={candidate.name}
                  className="relative block min-w-0 border-b border-slate-300 last:border-b-0"
                  title={title}
                  aria-busy={loading}
                >
                  <input
                    type="radio"
                    name={`${id}-source`}
                    value={candidate.name}
                    checked={selected}
                    autoFocus={selected}
                    className="peer sr-only"
                    aria-label={title}
                    onChange={() => {
                      setSourceName(candidate.name);
                      setSourceLoad(null);
                      setCreateSchemaOpen(false);
                      setNewSchemaName("");
                      setSchemaCreateError(null);
                      setSchemaName(
                        candidate.type === "postgres" ? "public" : candidate.type === "duckdb" ? "main" : ""
                      );
                      setError(null);
                    }}
                  />
                  <span
                    className={`flex min-w-0 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-black peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-black peer-disabled:cursor-not-allowed peer-disabled:opacity-50 ${selected ? "bg-blue-50" : "hover:bg-slate-100"}`}
                  >
                    <span
                      className="flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md border-2 border-black p-1.5"
                      style={{ backgroundColor: appearance.backgroundColor }}
                    >
                      <CliSourceIcon source={{ ...candidate, loading: false }} size={18} />
                      {connectionError && !loading && <AlertCircle aria-hidden="true" color="#b91c1c" size={14} />}
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <strong className="block truncate text-xs">{label}</strong>
                      <span className="block truncate text-[10px] text-slate-600">
                        {candidate.builtin ? "Files stored in this document" : candidate.type}
                      </span>
                      {loading ? (
                        <span role="status" className="sr-only">
                          Connecting…
                        </span>
                      ) : connectionError ? (
                        <span className="block truncate text-[10px] font-bold text-red-700">{connectionError}</span>
                      ) : null}
                    </span>
                    <span
                      aria-hidden="true"
                      className={`flex shrink-0 items-center justify-center gap-1.5 rounded-[7px] border-2 border-black px-2 py-1.5 text-[10px] font-extrabold shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] ${selected ? "bg-blue-100" : "bg-white"}`}
                    >
                      {loading ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : selected ? (
                        <Check size={13} strokeWidth={3} />
                      ) : (
                        <Database size={13} />
                      )}
                      <span className="kavla-control-label">{selected ? "Selected" : "Select"}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {sourceError && (
          <div
            role="alert"
            className="rounded-[7px] border-2 border-black bg-red-100 px-2.5 py-2 text-[11px] font-bold text-red-900 break-words"
          >
            {sourceError}
          </div>
        )}
        {needsSchema && (
          <div className="flex flex-col gap-2">
            {createSchemaOpen ? (
              <>
                <label className="flex flex-col gap-1 text-[11px] font-black">
                  NEW {schemaLabel.toUpperCase()}
                  <input
                    autoFocus
                    value={newSchemaName}
                    onChange={(event) => {
                      setNewSchemaName(event.target.value);
                      setSchemaCreateError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleCreateSchema();
                      }
                    }}
                    disabled={isBusy}
                    className={inputClass}
                    placeholder={source.type === "bigquery" ? "my_dataset" : "my_schema"}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={maxSchemaLength}
                  />
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy || !canCreateSchema}
                    onClick={() => void handleCreateSchema()}
                    className={`${buttonClass} bg-blue-100 hover:bg-blue-200`}
                    aria-busy={creatingSchema}
                  >
                    {creatingSchema ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    <span role={creatingSchema ? "status" : undefined}>
                      {creatingSchema
                        ? `Creating ${schemaLabel.toLowerCase()}…`
                        : `Create ${schemaLabel.toLowerCase()}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setCreateSchemaOpen(false);
                      setSchemaCreateError(null);
                    }}
                    className={`${buttonClass} bg-white`}
                  >
                    Cancel
                  </button>
                </div>
                {schemaCreateError && (
                  <div
                    role="alert"
                    className="rounded-[7px] border-2 border-black bg-red-100 px-2.5 py-2 text-[11px] font-bold text-red-900 break-words"
                  >
                    {schemaCreateError}
                  </div>
                )}
              </>
            ) : (
              <StoreSchemaSelect
                key={sourceName}
                title={schemaLabel}
                options={schemas}
                value={loadingSource ? "" : schemaName}
                onSelect={setSchemaName}
                onCreate={() => {
                  setCreateSchemaOpen(true);
                  setNewSchemaName("");
                  setSchemaCreateError(null);
                }}
                disabled={isBusy || loadingSource || Boolean(sourceError)}
                placeholder={loadingSource ? "Loading…" : `Select or create a ${schemaLabel.toLowerCase()}…`}
              />
            )}
          </div>
        )}
        <label className="flex flex-col gap-1 text-[11px] font-black">
          TABLE NAME
          <input
            required
            ref={tableNameInput}
            value={tableName}
            onChange={(event) => setTableName(event.target.value)}
            disabled={isBusy}
            className={inputClass}
            pattern="[a-zA-Z_][a-zA-Z0-9_]*"
          />
        </label>
        {error && (
          <div
            role="alert"
            className="rounded-[7px] border-2 border-black bg-red-100 px-2.5 py-2 text-[11px] font-bold text-red-900 break-words"
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={isBusy} className={`${buttonClass} bg-white`}>
            Cancel
          </button>
          <button type="submit" disabled={!canStore} className={`${buttonClass} bg-blue-100 hover:bg-blue-200`}>
            {storing ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
            {storing ? "Storing…" : "Store"}
          </button>
        </div>
      </form>
    </dialog>,
    document.body
  );
}
