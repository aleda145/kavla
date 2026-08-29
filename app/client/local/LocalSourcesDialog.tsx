import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronUp,
  Database,
  File,
  Folder,
  FolderOpen,
  Home,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { createShapeId, useEditor, useToasts } from "tldraw";
import type { ColumnMetadata, DataSourceShape } from "../../DataSource/data-source-types";
import { CliSourceIcon, getCliSourceAppearance } from "../../DataSource/CliSourcesList";
import { calculateDataSourceHeight, calculateDataSourceWidth } from "../../DataSource/ingestLocalDataSourceFile";
import { getRemoteTableDisplayName } from "../../DataSource/remote-source-metadata";
import { useData } from "../useLocalServer";
import { getUniqueName } from "../../util/getUniqueName";
import { getColumnTypeColor } from "../../util/column-colors";
import { toValidSqlName } from "../../util/sql";
import { quoteDottedIdentifier } from "../../src/duckdb/sql";
import {
  createCliSource,
  deleteCliSource,
  listCliSourcePath,
  loadCliSources,
  updateCliSource,
  type CliConfiguredSource,
  type CliSourceDefinition,
  type CliSourceInput,
  type CliSourcePathListing,
  type CliSourcesConfiguration,
} from "./localSources";

type LocalSourcesDialogProps = {
  onClose: () => void;
};

const emptyDraft: CliSourceInput = { name: "", type: "duckdb", connection: "" };

function CliSourceLogoBadge({ source, unavailable = false }: { source: { type: string }; unavailable?: boolean }) {
  const appearance = getCliSourceAppearance(source);
  return (
    <span
      style={{
        alignItems: "center",
        backgroundColor: appearance.backgroundColor,
        border: "2px solid #000",
        borderRadius: 6,
        boxSizing: "border-box",
        display: "flex",
        flexShrink: 0,
        gap: 5,
        justifyContent: "center",
        minHeight: 36,
        minWidth: 36,
        padding: 6,
      }}
    >
      <CliSourceIcon source={source} size={20} />
      {unavailable ? <AlertCircle color="#b91c1c" size={16} /> : null}
    </span>
  );
}

export function LocalSourcesDialog({ onClose }: LocalSourcesDialogProps) {
  const [configuration, setConfiguration] = useState<CliSourcesConfiguration | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [draft, setDraft] = useState<CliSourceInput>(emptyDraft);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathListing, setPathListing] = useState<CliSourcePathListing | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [showPathBrowser, setShowPathBrowser] = useState(false);
  const [browsingSource, setBrowsingSource] = useState<CliConfiguredSource | null>(null);
  const { addToast } = useToasts();
  const editor = useEditor();
  const { getSourceSchema, getSourceStats, getSourceTables } = useData();

  const definition = useMemo(
    () => configuration?.definitions.find((candidate) => candidate.type === draft.type) ?? null,
    [configuration?.definitions, draft.type]
  );
  const editingSource = useMemo(
    () => configuration?.sources.find((source) => source.name === editingName) ?? null,
    [configuration?.sources, editingName]
  );

  useEffect(() => {
    let cancelled = false;
    void loadCliSources()
      .then((nextConfiguration) => {
        if (!cancelled) setConfiguration(nextConfiguration);
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      if (showPathBrowser) {
        setShowPathBrowser(false);
      } else if (showEditor) {
        setShowEditor(false);
        setEditingName(null);
      } else if (browsingSource) {
        setBrowsingSource(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [browsingSource, onClose, saving, showEditor, showPathBrowser]);

  const beginCreate = () => {
    const sourceType = configuration?.definitions[0]?.type ?? "duckdb";
    setEditingName(null);
    setDraft({ name: "", type: sourceType, connection: "" });
    setError(null);
    setShowPathBrowser(false);
    setBrowsingSource(null);
    setShowEditor(true);
  };

  const beginEdit = (source: CliConfiguredSource) => {
    setEditingName(source.name);
    setDraft({ name: source.name, type: source.type, connection: source.connection });
    setError(null);
    setShowPathBrowser(false);
    setBrowsingSource(null);
    setShowEditor(true);
  };

  const createTableDataSource = (
    source: CliConfiguredSource,
    table: string,
    details: { columns: ColumnMetadata[] | null; rowCount: number | null }
  ) => {
    const displayTableName = getRemoteTableDisplayName(table);
    const shapeId = createShapeId();
    const metadata = details.columns;
    const viewport = editor.getViewportPageBounds();
    const width = calculateDataSourceWidth(metadata, displayTableName);
    const height = calculateDataSourceHeight(metadata, details.rowCount);
    editor.createShape<DataSourceShape>({
      id: shapeId,
      type: "data-source",
      x: viewport.center.x - width / 2,
      y: viewport.center.y - height / 2,
      props: {
        filename: displayTableName,
        name: getUniqueName(editor, toValidSqlName(displayTableName), shapeId),
        sourceName: source.name,
        sourceType: source.type,
        remoteTableRef: table,
        metadata,
        rowCount: details.rowCount,
        isRunning: metadata === null,
        error: null,
        h: height,
        w: width,
      },
    });
    editor.select(shapeId);
    window.setTimeout(() => editor.zoomToSelection({ animation: { duration: 250 } }), 50);
    addToast({
      title: "Data source added",
      description: `${source.name} · ${table}`,
      severity: "success",
    });
    onClose();
  };

  const saveSource = async () => {
    if (!draft.name.trim() || !draft.connection.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const nextConfiguration = editingName ? await updateCliSource(editingName, draft) : await createCliSource(draft);
      setConfiguration(nextConfiguration);
      const savedSource = nextConfiguration.sources.find((source) => source.name === draft.name.trim());
      if (savedSource) beginEdit(savedSource);
      addToast({
        title: savedSource?.available
          ? editingName
            ? "CLI source updated"
            : "CLI source added"
          : "CLI source saved but unavailable",
        description: savedSource?.available
          ? `${draft.name.trim()} is available to the canvas immediately.`
          : (savedSource?.error ?? "Check the source connection and save again."),
        severity: savedSource?.available ? "success" : "warning",
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const removeSource = async () => {
    if (!editingName || saving) return;
    if (!window.confirm(`Remove CLI source “${editingName}”? This updates the CLI configuration on disk.`)) return;
    setSaving(true);
    setError(null);
    try {
      setConfiguration(await deleteCliSource(editingName));
      addToast({ title: "CLI source removed", description: editingName, severity: "success" });
      setEditingName(null);
      setShowEditor(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const openPath = async (path?: string) => {
    setPathLoading(true);
    setError(null);
    try {
      setPathListing(await listCliSourcePath(path));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPathLoading(false);
    }
  };

  const beginBrowse = () => {
    if (!definition || definition.connectionKind === "text") return;
    setShowPathBrowser(true);
    const currentPath = draft.connection.trim();
    const initialPath = currentPath.startsWith("/")
      ? definition.connectionKind === "path_file"
        ? currentPath.slice(0, currentPath.lastIndexOf("/")) || "/"
        : currentPath
      : undefined;
    void openPath(initialPath);
  };

  const editorTitle = editingName ? `Edit ${editingName}` : "Add CLI source";

  return createPortal(
    <div
      aria-label="CLI sources"
      aria-modal="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      role="dialog"
      style={overlayStyle}
    >
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <div style={{ alignItems: "center", display: "flex", fontSize: 14, fontWeight: 900, gap: 8 }}>
            <Database size={18} strokeWidth={2.7} /> CLI sources
          </div>
          <button
            aria-label="Close CLI sources"
            disabled={saving}
            onClick={onClose}
            style={iconButtonStyle}
            type="button"
          >
            <X size={19} strokeWidth={3} />
          </button>
        </div>

        {loading ? (
          <div style={loadingStyle}>
            <Loader2 className="animate-spin" size={22} /> Loading CLI configuration…
          </div>
        ) : browsingSource ? (
          <SourceTablesBrowser
            getSourceSchema={getSourceSchema}
            getSourceStats={getSourceStats}
            getSourceTables={getSourceTables}
            onBack={() => setBrowsingSource(null)}
            onQuery={(table, details) => createTableDataSource(browsingSource, table, details)}
            source={browsingSource}
          />
        ) : showEditor ? (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={subheaderStyle}>
              <button
                aria-label="Back to CLI sources"
                disabled={saving}
                onClick={() => {
                  setShowEditor(false);
                  setShowPathBrowser(false);
                }}
                style={iconButtonBorderedStyle}
                type="button"
              >
                <ChevronLeft size={17} />
              </button>
              <CliSourceLogoBadge source={{ type: draft.type }} />
              <strong>{editorTitle}</strong>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 13,
                minHeight: 0,
                overflowY: "auto",
                padding: 16,
              }}
            >
              <label style={fieldLabelStyle}>
                SOURCE TYPE
                <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
                  <CliSourceLogoBadge source={{ type: draft.type }} />
                  <select
                    disabled={saving}
                    onChange={(event) => setDraft({ ...draft, type: event.currentTarget.value, connection: "" })}
                    style={{ ...fieldStyle, flex: 1 }}
                    value={draft.type}
                  >
                    {configuration?.definitions.map((candidate) => (
                      <option key={candidate.type} value={candidate.type}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>

              <label style={fieldLabelStyle}>
                SOURCE NAME
                <input
                  autoFocus
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                  placeholder="analytics"
                  spellCheck={false}
                  style={fieldStyle}
                  value={draft.name}
                />
                <span style={helpStyle}>Letters, numbers, and underscores. Must start with a letter.</span>
              </label>

              <label style={fieldLabelStyle}>
                {definition?.connectionLabel.toUpperCase() ?? "CONNECTION"}
                <div style={{ display: "flex", gap: 7 }}>
                  <input
                    disabled={saving}
                    onChange={(event) => setDraft({ ...draft, connection: event.currentTarget.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !saving) void saveSource();
                    }}
                    placeholder={definition?.connectionHelp.split("Example:")[1]?.trim() ?? "Connection"}
                    spellCheck={false}
                    style={{
                      ...fieldStyle,
                      flex: 1,
                      fontFamily: definition?.connectionKind === "text" ? "Inter, sans-serif" : "monospace",
                    }}
                    value={draft.connection}
                  />
                  {definition && definition.connectionKind !== "text" ? (
                    <button disabled={saving} onClick={beginBrowse} style={secondaryButtonStyle} type="button">
                      <FolderOpen size={15} /> Browse
                    </button>
                  ) : null}
                </div>
                <span style={helpStyle}>{definition?.connectionHelp}</span>
              </label>

              {showPathBrowser && definition ? (
                <PathBrowser
                  kind={definition.connectionKind}
                  listing={pathListing}
                  loading={pathLoading}
                  onChoose={(path) => {
                    setDraft({ ...draft, connection: path });
                    setShowPathBrowser(false);
                  }}
                  onOpen={openPath}
                />
              ) : null}

              {editingSource ? (
                <div style={editingSource.available ? availableStyle : errorStyle}>
                  {editingSource.available ? (
                    <span>Connected and available to the canvas.</span>
                  ) : (
                    <>
                      <AlertCircle size={15} /> {editingSource.error || "This source is unavailable."}
                    </>
                  )}
                </div>
              ) : null}

              {error ? <div style={errorStyle}>{error}</div> : null}

              <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" }}>
                <div>
                  {editingName ? (
                    <button
                      disabled={saving}
                      onClick={() => void removeSource()}
                      style={dangerButtonStyle}
                      type="button"
                    >
                      <Trash2 size={15} /> Remove
                    </button>
                  ) : null}
                </div>
                <button
                  disabled={saving || !draft.name.trim() || !draft.connection.trim()}
                  onClick={() => void saveSource()}
                  style={{
                    ...primaryButtonStyle,
                    opacity: saving || !draft.name.trim() || !draft.connection.trim() ? 0.5 : 1,
                  }}
                  type="button"
                >
                  {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
                  {editingName ? "Save changes" : "Add source"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, padding: 16 }}>
            <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between" }}>
              <div style={{ fontSize: 12, fontWeight: 750 }}>Configured data sources</div>
              <button onClick={beginCreate} style={primaryButtonStyle} type="button">
                <Plus size={15} /> Add source
              </button>
            </div>

            <div style={sourceListStyle}>
              {configuration?.sources.length ? (
                configuration.sources.map((source) => {
                  return (
                    <div key={source.name} style={sourceRowStyle}>
                      <span style={{ alignItems: "center", display: "flex", gap: 9, minWidth: 0 }}>
                        <CliSourceLogoBadge source={source} unavailable={!source.available} />
                        <span
                          style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, textAlign: "left" }}
                        >
                          <strong style={{ fontSize: 13 }}>{source.name}</strong>
                          <span
                            style={{
                              color: "#475569",
                              fontSize: 11,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {source.type} · {source.connection}
                          </span>
                          {source.error ? (
                            <span style={{ color: "#b91c1c", fontSize: 10, fontWeight: 700 }}>{source.error}</span>
                          ) : null}
                        </span>
                      </span>
                      <span style={{ display: "flex", flexShrink: 0, gap: 6 }}>
                        <button
                          disabled={!source.available}
                          onClick={() => setBrowsingSource(source)}
                          style={{ ...primaryButtonStyle, opacity: source.available ? 1 : 0.45 }}
                          title={source.available ? `Browse tables in ${source.name}` : source.error}
                          type="button"
                        >
                          <Database size={14} /> Tables
                        </button>
                        <button
                          aria-label={`Edit ${source.name}`}
                          onClick={() => beginEdit(source)}
                          style={{
                            ...iconButtonBorderedStyle,
                            alignSelf: "center",
                            justifyContent: "center",
                            width: 34,
                          }}
                          type="button"
                        >
                          <Pencil size={15} />
                        </button>
                      </span>
                    </div>
                  );
                })
              ) : (
                <div style={loadingStyle}>No CLI sources configured yet.</div>
              )}
            </div>

            {error ? <div style={errorStyle}>{error}</div> : null}
            <div
              style={{
                color: "#64748b",
                fontFamily: "monospace",
                fontSize: 10,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={configuration?.configPath}
            >
              Saved to {configuration?.configPath}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

type SourceTableDetails = {
  columns: ColumnMetadata[] | null;
  rowCount: number | null;
};

function SourceTablesBrowser({
  getSourceSchema,
  getSourceStats,
  getSourceTables,
  onBack,
  onQuery,
  source,
}: {
  getSourceSchema: ReturnType<typeof useData>["getSourceSchema"];
  getSourceStats: ReturnType<typeof useData>["getSourceStats"];
  getSourceTables: ReturnType<typeof useData>["getSourceTables"];
  onBack: () => void;
  onQuery: (table: string, details: SourceTableDetails) => void;
  source: CliConfiguredSource;
}) {
  const [tables, setTables] = useState<string[]>([]);
  const [loadingTables, setLoadingTables] = useState(true);
  const [tableError, setTableError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [details, setDetails] = useState<SourceTableDetails>({ columns: null, rowCount: null });
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoadingTables(true);
    setTableError(null);
    void getSourceTables({ sourceName: source.name })
      .then((result) => {
        if (!cancelled) setTables([...result.tables].sort((left, right) => left.localeCompare(right)));
      })
      .catch((nextError) => {
        if (!cancelled) setTableError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getSourceTables, source.name]);

  useEffect(() => {
    if (!selectedTable) {
      setDetails({ columns: null, rowCount: null });
      return;
    }
    let cancelled = false;
    setLoadingDetails(true);
    setDetailsError(null);
    setDetails({ columns: null, rowCount: null });
    const tableRef = quoteDottedIdentifier(selectedTable);
    void Promise.all([getSourceSchema({ tableRef }), getSourceStats({ tableRef })])
      .then(([schemaResult, statsResult]) => {
        if (!cancelled) {
          setDetails({ columns: schemaResult.columns, rowCount: Number(statsResult.rowCount) });
        }
      })
      .catch((nextError) => {
        if (!cancelled) setDetailsError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetails(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getSourceSchema, getSourceStats, selectedTable]);

  const visibleTables = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? tables.filter((table) => table.toLowerCase().includes(query)) : tables;
  }, [search, tables]);
  const namespaceCount = useMemo(() => {
    const namespaces = new Set(
      tables.map((table) => {
        const path = table.split(".");
        return path.length > 2 ? path.slice(1, -1).join(".") : "main";
      })
    );
    return namespaces.size;
  }, [tables]);
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const column of details.columns ?? []) {
      const normalizedType = column.type.split("(")[0].trim().toUpperCase();
      counts.set(normalizedType, (counts.get(normalizedType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [details.columns]);
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={subheaderStyle}>
        <button aria-label="Back to CLI sources" onClick={onBack} style={iconButtonBorderedStyle} type="button">
          <ChevronLeft size={17} />
        </button>
        <CliSourceLogoBadge source={source} />
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <strong>{source.name}</strong>
          <span style={{ color: "#64748b", fontSize: 10 }}>
            {source.type} ·{" "}
            {loadingTables ? "Loading tables…" : `${tables.length} tables/views · ${namespaceCount} namespaces`}
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          flex: 1,
          gridTemplateColumns: "minmax(210px, 0.85fr) minmax(280px, 1.15fr)",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <div style={{ borderRight: "2px solid #000", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ alignItems: "center", borderBottom: "1px solid #cbd5e1", display: "flex", gap: 6, padding: 8 }}>
            <Search color="#64748b" size={14} />
            <input
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="Filter tables…"
              spellCheck={false}
              style={{
                border: 0,
                flex: 1,
                fontFamily: "Inter, sans-serif",
                fontSize: 11,
                fontWeight: 700,
                minWidth: 0,
                outline: "none",
              }}
              value={search}
            />
          </div>
          <div style={{ flex: 1, minHeight: 260, overflowY: "auto" }}>
            {loadingTables ? (
              <div style={loadingStyle}>
                <Loader2 className="animate-spin" size={18} /> Loading…
              </div>
            ) : tableError ? (
              <div style={{ ...errorStyle, margin: 10 }}>{tableError}</div>
            ) : visibleTables.length === 0 ? (
              <div style={loadingStyle}>{tables.length ? "No matching tables." : "No tables or views found."}</div>
            ) : (
              visibleTables.map((table) => (
                <button
                  key={table}
                  onClick={() => setSelectedTable(table)}
                  style={{
                    ...tableListRowStyle,
                    backgroundColor: selectedTable === table ? "#dbeafe" : "transparent",
                    borderLeft: selectedTable === table ? "5px solid #000" : "5px solid transparent",
                  }}
                  title={table}
                  type="button"
                >
                  <Database size={13} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{table}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          {!selectedTable ? (
            <div style={loadingStyle}>Select a table to inspect its schema and row count.</div>
          ) : (
            <>
              <div
                style={{
                  alignItems: "center",
                  backgroundColor: "#f8fafc",
                  borderBottom: "2px solid #000",
                  display: "flex",
                  gap: 8,
                  justifyContent: "space-between",
                  padding: "9px 11px",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <strong
                    style={{
                      fontFamily: "monospace",
                      fontSize: 11,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={selectedTable}
                  >
                    {selectedTable}
                  </strong>
                  <span style={{ color: "#64748b", fontSize: 10 }}>
                    {loadingDetails
                      ? "Reading table statistics…"
                      : `${details.rowCount?.toLocaleString() ?? "Unknown"} rows · ${details.columns?.length ?? "Unknown"} columns`}
                  </span>
                </div>
                <button
                  disabled={loadingDetails || details.columns === null}
                  onClick={() => onQuery(selectedTable, details)}
                  style={{
                    ...queryButtonStyle,
                    flexShrink: 0,
                    opacity: loadingDetails || details.columns === null ? 0.5 : 1,
                  }}
                  title={
                    details.columns === null
                      ? "Load the table schema before adding this source"
                      : "Add this table to the canvas as a data source"
                  }
                  type="button"
                >
                  <Plus size={15} /> Query
                </button>
              </div>

              <div
                style={{
                  display: "flex",
                  flex: 1,
                  flexDirection: "column",
                  gap: 10,
                  minHeight: 0,
                  overflowY: "auto",
                  padding: 11,
                }}
              >
                {detailsError ? <div style={errorStyle}>{detailsError}</div> : null}
                {typeCounts.length ? (
                  <div>
                    <div style={sectionLabelStyle}>COLUMN TYPES</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                      {typeCounts.map(([type, count]) => (
                        <span className={getColumnTypeColor(type)} key={type} style={typeBadgeStyle}>
                          {count} {type}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {details.columns?.length ? (
                  <div>
                    <div style={sectionLabelStyle}>SCHEMA</div>
                    <div style={{ border: "2px solid #000", borderRadius: 7, overflow: "hidden" }}>
                      {details.columns.map((column) => {
                        const typeColor = getColumnTypeColor(column.type);
                        return (
                          <div key={column.name} style={schemaRowStyle}>
                            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {column.name}
                            </strong>
                            <span
                              className={typeColor}
                              style={{
                                color: "#000",
                                fontFamily: "monospace",
                                fontSize: 10,
                                padding: typeColor ? "1px 6px" : 0,
                              }}
                            >
                              {column.type}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : loadingDetails ? (
                  <div style={loadingStyle}>
                    <Loader2 className="animate-spin" size={18} /> Reading schema…
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PathBrowser({
  kind,
  listing,
  loading,
  onChoose,
  onOpen,
}: {
  kind: CliSourceDefinition["connectionKind"];
  listing: CliSourcePathListing | null;
  loading: boolean;
  onChoose: (path: string) => void;
  onOpen: (path?: string) => Promise<void>;
}) {
  return (
    <div
      style={{
        backgroundColor: "#f8fafc",
        border: "2px solid #000",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ alignItems: "center", borderBottom: "2px solid #000", display: "flex", gap: 6, padding: 7 }}>
        <button
          disabled={!listing?.homePath || loading}
          onClick={() => void onOpen(listing?.homePath)}
          style={smallNavigationButtonStyle}
          title="Home"
          type="button"
        >
          <Home size={14} />
        </button>
        <button
          disabled={!listing?.parentPath || loading}
          onClick={() => void onOpen(listing?.parentPath)}
          style={smallNavigationButtonStyle}
          title="Parent"
          type="button"
        >
          <ChevronUp size={16} />
        </button>
        <span
          style={{
            flex: 1,
            fontFamily: "monospace",
            fontSize: 10,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={listing?.path}
        >
          {listing?.path ?? "Opening…"}
        </span>
        {kind === "path_directory" && listing ? (
          <button disabled={loading} onClick={() => onChoose(listing.path)} style={primaryButtonStyle} type="button">
            Use folder
          </button>
        ) : null}
      </div>
      <div style={{ maxHeight: 210, minHeight: 110, overflowY: "auto" }}>
        {loading ? (
          <div style={loadingStyle}>
            <Loader2 className="animate-spin" size={18} /> Opening…
          </div>
        ) : (
          listing?.entries.map((entry) => {
            if (kind === "path_directory" && entry.type === "file") return null;
            return (
              <button
                key={entry.path}
                onClick={() => (entry.type === "directory" ? void onOpen(entry.path) : onChoose(entry.path))}
                style={pathRowStyle}
                title={entry.path}
                type="button"
              >
                {entry.type === "directory" ? <Folder fill="#fde68a" size={16} /> : <File size={16} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

const overlayStyle = {
  alignItems: "center",
  backgroundColor: "rgba(15, 23, 42, 0.32)",
  display: "flex",
  inset: 0,
  justifyContent: "center",
  padding: 20,
  pointerEvents: "all" as const,
  position: "fixed" as const,
  zIndex: 1_000_000,
};
const dialogStyle = {
  backgroundColor: "#fff",
  border: "3px solid #000",
  borderRadius: 12,
  boxShadow: "6px 6px 0 0 #000",
  color: "#000",
  display: "flex",
  flexDirection: "column" as const,
  fontFamily: "Inter, sans-serif",
  maxHeight: "min(720px, calc(100vh - 40px))",
  minHeight: 340,
  overflow: "hidden",
  width: "min(680px, calc(100vw - 40px))",
};
const headerStyle = {
  alignItems: "center",
  backgroundColor: "#dbeafe",
  borderBottom: "3px solid #000",
  display: "flex",
  justifyContent: "space-between",
  padding: "11px 14px",
};
const subheaderStyle = {
  alignItems: "center",
  backgroundColor: "#eff6ff",
  borderBottom: "2px solid #000",
  display: "flex",
  fontSize: 13,
  gap: 9,
  padding: "8px 12px",
};
const iconButtonStyle = { background: "transparent", border: 0, cursor: "pointer", display: "flex", padding: 2 };
const iconButtonBorderedStyle = {
  ...iconButtonStyle,
  backgroundColor: "#fff",
  border: "2px solid #000",
  borderRadius: 6,
  padding: 3,
};
const fieldLabelStyle = { display: "flex", flexDirection: "column" as const, fontSize: 11, fontWeight: 900, gap: 5 };
const fieldStyle = {
  backgroundColor: "#fff",
  border: "2px solid #000",
  borderRadius: 7,
  color: "#000",
  fontFamily: "Inter, sans-serif",
  fontSize: 13,
  fontWeight: 700,
  minWidth: 0,
  outline: "none",
  padding: "8px 10px",
};
const helpStyle = { color: "#64748b", fontSize: 10, fontWeight: 650, lineHeight: 1.35 };
const loadingStyle = {
  alignItems: "center",
  color: "#475569",
  display: "flex",
  flex: 1,
  fontSize: 12,
  fontWeight: 700,
  gap: 8,
  justifyContent: "center",
  minHeight: 160,
  padding: 20,
};
const errorStyle = {
  backgroundColor: "#fee2e2",
  border: "2px solid #000",
  borderRadius: 7,
  color: "#7f1d1d",
  fontSize: 11,
  fontWeight: 700,
  overflowWrap: "anywhere" as const,
  padding: "8px 10px",
};
const availableStyle = {
  alignItems: "center",
  backgroundColor: "#dcfce7",
  border: "2px solid #000",
  borderRadius: 7,
  color: "#14532d",
  display: "flex",
  fontSize: 11,
  fontWeight: 750,
  gap: 7,
  padding: "8px 10px",
};
const primaryButtonStyle = {
  alignItems: "center",
  backgroundColor: "#dbeafe",
  border: "2px solid #000",
  borderRadius: 7,
  boxShadow: "2px 2px 0 0 rgba(0,0,0,0.2)",
  color: "#000",
  cursor: "pointer",
  display: "flex",
  fontSize: 11,
  fontWeight: 850,
  gap: 6,
  justifyContent: "center",
  padding: "7px 10px",
};
const queryButtonStyle = { ...primaryButtonStyle, backgroundColor: "#fde68a" };
const secondaryButtonStyle = { ...primaryButtonStyle, backgroundColor: "#fff" };
const dangerButtonStyle = { ...primaryButtonStyle, backgroundColor: "#fecaca", color: "#7f1d1d" };
const smallNavigationButtonStyle = {
  alignItems: "center",
  backgroundColor: "#fff",
  border: "2px solid #000",
  borderRadius: 6,
  cursor: "pointer",
  display: "flex",
  height: 27,
  justifyContent: "center",
  width: 29,
};
const sourceListStyle = {
  backgroundColor: "#f8fafc",
  border: "2px solid #000",
  borderRadius: 8,
  flex: 1,
  minHeight: 220,
  overflowY: "auto" as const,
};
const sourceRowStyle = {
  alignItems: "center",
  backgroundColor: "transparent",
  borderBottom: "1px solid #cbd5e1",
  color: "#000",
  display: "flex",
  fontFamily: "Inter, sans-serif",
  gap: 10,
  justifyContent: "space-between",
  padding: "10px 11px",
  width: "100%",
};
const pathRowStyle = {
  alignItems: "center",
  backgroundColor: "transparent",
  border: 0,
  borderBottom: "1px solid #cbd5e1",
  color: "#000",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, sans-serif",
  fontSize: 11,
  fontWeight: 750,
  gap: 8,
  padding: "7px 9px",
  textAlign: "left" as const,
  width: "100%",
};
const tableListRowStyle = {
  alignItems: "center",
  border: 0,
  borderBottom: "1px solid #e2e8f0",
  color: "#000",
  cursor: "pointer",
  display: "flex",
  fontFamily: "monospace",
  fontSize: 10,
  fontWeight: 700,
  gap: 7,
  padding: "8px 9px",
  textAlign: "left" as const,
  width: "100%",
};
const sectionLabelStyle = { fontSize: 10, fontWeight: 900, letterSpacing: "0.06em", marginBottom: 6 };
const typeBadgeStyle = {
  border: "1.5px solid #000",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: 9,
  fontWeight: 800,
  padding: "3px 6px",
};
const schemaRowStyle = {
  alignItems: "center",
  borderBottom: "1px solid #cbd5e1",
  display: "flex",
  fontSize: 10,
  gap: 8,
  justifyContent: "space-between",
  padding: "6px 8px",
};
