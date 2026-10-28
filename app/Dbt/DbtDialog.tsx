import { dbtColors } from "./dbtColors";
import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, RefreshCw, X } from "lucide-react";
import { useEditor, useValue, type TLShapeId } from "tldraw";
import { listLocalSessionDirectory, type KavlaDirectoryListing } from "../client/local/localSession";
import { dbtController, dbtShapes, dbtState } from "./dbtRuntime";
import { useCliSources } from "../client/useLocalServer";
import { DbtLogo } from "./DbtFileUtil";
import { updateDbtFile, getDbtHiddenDrafts } from "./dbtCanvas";
import type { DbtFileView } from "./dbtTypes";

const button: CSSProperties = {
  border: "2px solid #000",
  borderRadius: 4,
  padding: "7px 10px",
  background: "white",
  fontSize: 12,
  fontWeight: 750,
  cursor: "pointer",
  boxShadow: "2px 2px 0 #000",
};
const input: CSSProperties = {
  border: "2px solid #000",
  borderRadius: 4,
  padding: "8px 10px",
  fontFamily: "monospace",
  width: "100%",
  boxSizing: "border-box",
  background: "white",
  color: "#000",
};

export function DbtDialog({ onClose, initialShapeId }: { onClose: () => void; initialShapeId?: TLShapeId }) {
  const editor = useEditor();
  const connections = useCliSources().filter((source) => source.name !== "uploaded_files");
  const state = useValue("dbt project", () => dbtState.get(), []);
  const hiddenDrafts = useValue("recovered dbt drafts", () => getDbtHiddenDrafts(editor), [editor]);
  const shapes = useValue("dbt files", () => dbtShapes(editor), [editor]);
  const [sourceName, setSourceName] = useState(state.project?.binding?.sourceName ?? "");
  const [path, setPath] = useState(state.project?.binding?.root ?? "");
  const [listing, setListing] = useState<KavlaDirectoryListing | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<TLShapeId | undefined>(initialShapeId);
  const [filter, setFilter] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const selectedShape = shapes.find((shape) => shape.id === selected);
  const selectedIssue = selected ? state.issues[selected] : undefined;
  const binding = state.project?.binding;
  const linked = shapes.filter((shape) => shape.props.bindingId === binding?.id);
  const drafts = linked.filter((shape) => shape.props.text !== shape.props.baseText);
  const conflicts = Object.values(state.issues).filter((issue) => issue.kind === "conflict").length;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, working]);
  useEffect(() => {
    if (binding) {
      setPath(binding.root);
      setSourceName(binding.sourceName ?? "");
    }
  }, [binding?.root, binding?.sourceName]);

  async function perform(action: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  }
  async function browse(directory?: string) {
    await perform(async () => {
      setListing(await listLocalSessionDirectory(directory));
      setBrowsing(true);
    });
  }
  function downloadDraft(shape: Pick<DbtFileView, "props"> | { props: { text: string; path: string } }) {
    const url = URL.createObjectURL(new Blob([shape.props.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = shape.props.path.split("/").pop() || "dbt-draft.sql";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="dbt project"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !working) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !working) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,.32)",
        zIndex: 1_000_000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "all",
        color: "#000",
      }}
    >
      <div
        style={{
          width: selectedIssue?.disk ? 1000 : 700,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          background: "white",
          border: "3px solid #000",
          borderRadius: 10,
          boxShadow: "6px 6px 0 #000",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            padding: "14px 18px",
            borderBottom: "3px solid #000",
            background: dbtColors.surface,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <DbtLogo size={24} />
          <strong style={{ fontSize: 18, flex: 1 }}>dbt project</strong>
          <button
            type="button"
            style={{ ...button, padding: 4 }}
            onClick={onClose}
            disabled={working}
            aria-label="Close dbt settings"
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
            Connect a folder containing <code>dbt_project.yml</code>. Models become runnable SQL nodes. Follow refs
            upstream, explore results as tables and charts, and keep edits synced to the project.
          </p>
          {(error || state.error) && (
            <div
              role="alert"
              style={{
                padding: 10,
                border: "2px solid #991b1b",
                background: "#fee2e2",
                fontSize: 12,
                overflowWrap: "anywhere",
              }}
            >
              {error || state.error}
            </div>
          )}
          <label style={{ fontSize: 12, fontWeight: 800 }}>
            Warehouse for dbt sources
            <select
              aria-label="Warehouse for dbt sources"
              value={sourceName}
              disabled={working}
              onChange={(event) => setSourceName(event.target.value)}
              style={{ ...input, marginTop: 6 }}
            >
              <option value="">Choose a Kavla connection (seeds work without one)</option>
              {connections.map((connection) => (
                <option key={connection.name} value={connection.name}>
                  {connection.name} · {connection.type}
                </option>
              ))}
            </select>
            <span style={{ display: "block", fontWeight: 400, marginTop: 6 }}>
              source() uses this connection with the schema and identifier from your source YAML.
            </span>
            {binding && sourceName !== (binding.sourceName ?? "") && (
              <button
                type="button"
                style={{ ...button, marginTop: 8 }}
                disabled={working}
                onClick={() => void perform(() => dbtController(editor).connect(binding.root, sourceName))}
              >
                Apply connection
              </button>
            )}
          </label>
          {!binding || state.error ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ fontSize: 12, fontWeight: 800 }} htmlFor="dbt-project-path">
                Project folder on the Kavla server
              </label>
              <input
                id="dbt-project-path"
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/path/to/dbt-project"
                style={input}
                disabled={working}
              />
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" style={button} disabled={working} onClick={() => void browse(path || undefined)}>
                  <FolderOpen size={13} style={{ display: "inline", verticalAlign: "middle" }} /> Browse folders
                </button>
                <button
                  type="button"
                  style={{ ...button, background: "#fed7aa" }}
                  disabled={working || !path.trim()}
                  onClick={() => void perform(() => dbtController(editor).connect(path.trim(), sourceName))}
                >
                  Connect project
                </button>
              </div>
              {browsing && listing && (
                <div style={{ border: "2px solid #000", borderRadius: 4, padding: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    {listing.parentPath && (
                      <button
                        type="button"
                        style={button}
                        disabled={working}
                        onClick={() => void browse(listing.parentPath)}
                      >
                        Up
                      </button>
                    )}
                    <button
                      type="button"
                      style={button}
                      disabled={working}
                      onClick={() => {
                        setPath(listing.path);
                        setBrowsing(false);
                      }}
                    >
                      Use this folder
                    </button>
                  </div>
                  <div style={{ fontSize: 11, overflowWrap: "anywhere", marginBottom: 8 }}>{listing.path}</div>
                  <div style={{ maxHeight: 180, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {listing.entries
                      .filter((entry) => entry.type === "directory")
                      .map((entry) => (
                        <button
                          type="button"
                          key={entry.path}
                          disabled={working}
                          style={{ ...button, boxShadow: "none", textAlign: "left" }}
                          onClick={() => void browse(entry.path)}
                        >
                          📁 {entry.name}
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ padding: 12, border: "2px solid #000", borderRadius: 6, background: dbtColors.subtle }}>
              <strong>{state.project?.name}</strong>
              <div style={{ fontSize: 11, overflowWrap: "anywhere", marginTop: 4 }}>{binding.root}</div>
              <p role="status" style={{ fontSize: 12, margin: "10px 0" }}>
                {linked.length} files · {drafts.length} pending · {conflicts} conflicts ·{" "}
                {state.paused
                  ? "Paused"
                  : state.busy
                    ? "Syncing…"
                    : state.lastSync
                      ? `Last synced ${new Date(state.lastSync).toLocaleTimeString()}`
                      : "Connected"}
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={button}
                  disabled={working || state.busy}
                  onClick={() => void perform(() => dbtController(editor).sync(true))}
                >
                  <RefreshCw size={12} style={{ display: "inline" }} /> Sync now
                </button>
                <button
                  type="button"
                  style={button}
                  disabled={working}
                  onClick={() => dbtController(editor).pause(!state.paused)}
                >
                  {state.paused ? "Resume sync" : "Pause sync"}
                </button>
                <button
                  type="button"
                  style={button}
                  onClick={() => {
                    dbtController(editor).focus();
                    onClose();
                  }}
                >
                  Show on canvas
                </button>
              </div>
            </div>
          )}
          {binding && (
            <div>
              {disconnecting ? (
                <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <span>
                    Disconnect this project? Canvas nodes and unsynced drafts stay here. Files on disk are kept.
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      style={button}
                      disabled={working}
                      onClick={() =>
                        void perform(async () => {
                          await dbtController(editor).disconnect();
                          setDisconnecting(false);
                        })
                      }
                    >
                      Disconnect project
                    </button>
                    <button type="button" style={button} onClick={() => setDisconnecting(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  style={{ ...button, boxShadow: "none" }}
                  disabled={working}
                  onClick={() => setDisconnecting(true)}
                >
                  Disconnect…
                </button>
              )}
            </div>
          )}
          {hiddenDrafts.length > 0 && (
            <details style={{ fontSize: 12 }}>
              <summary>Recovered file drafts ({hiddenDrafts.length})</summary>
              <p>
                YAML, README, and seed file cards have been removed. Unsaved edits are preserved here; download a draft
                to review it in your editor.
              </p>
              {hiddenDrafts.map((draft, index) => (
                <button
                  type="button"
                  key={`${draft.id}-${index}`}
                  style={{ ...button, margin: 4 }}
                  title={draft.projectRoot}
                  onClick={() => downloadDraft({ props: draft })}
                >
                  Download {draft.path}
                </button>
              ))}
            </details>
          )}
          {shapes.length > 0 && (
            <div>
              <input
                aria-label="Filter dbt files"
                placeholder="Find a file…"
                style={input}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              <div
                style={{ maxHeight: 200, overflow: "auto", marginTop: 8, border: "2px solid #000", borderRadius: 4 }}
              >
                {shapes
                  .filter((shape) => shape.props.path.toLowerCase().includes(filter.toLowerCase()))
                  .map((shape) => (
                    <button
                      type="button"
                      key={shape.id}
                      onClick={() => setSelected(shape.id)}
                      style={{
                        display: "flex",
                        gap: 8,
                        width: "100%",
                        border: 0,
                        borderBottom: "1px solid #ddd",
                        background: selected === shape.id ? dbtColors.surface : "white",
                        padding: "8px 10px",
                        textAlign: "left",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      <span style={{ flex: 1, overflowWrap: "anywhere" }}>{shape.props.path}</span>
                      <strong style={{ color: state.issues[shape.id] ? "#b91c1c" : "#64748b", whiteSpace: "nowrap" }}>
                        {state.issues[shape.id]?.kind ??
                          (shape.props.bindingId !== binding?.id
                            ? "detached"
                            : shape.props.text !== shape.props.baseText
                              ? "pending"
                              : "synced")}
                      </strong>
                    </button>
                  ))}
              </div>
            </div>
          )}
          {selectedShape && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <strong style={{ fontSize: 12, overflowWrap: "anywhere" }}>{selectedShape.props.path}</strong>
              {selectedIssue && (
                <div role="status" style={{ fontSize: 12, color: "#991b1b" }}>
                  {selectedIssue.message}
                </div>
              )}
              {selectedIssue?.disk && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                  {[
                    { label: "Canvas draft", text: selectedShape.props.text },
                    { label: "File on disk", text: selectedIssue.disk.text },
                  ].map((version) => (
                    <label key={version.label} style={{ fontSize: 12, fontWeight: 800 }}>
                      {version.label}
                      <textarea
                        readOnly
                        value={version.text}
                        aria-label={version.label}
                        spellCheck={false}
                        style={{
                          ...input,
                          height: 230,
                          fontSize: 11,
                          marginTop: 6,
                          whiteSpace: "pre",
                          resize: "vertical",
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {selectedIssue?.disk && (
                  <>
                    <button
                      type="button"
                      disabled={working}
                      style={button}
                      onClick={() => void perform(() => dbtController(editor).resolve(selectedShape.id, "disk"))}
                    >
                      Use disk version
                    </button>
                    <button
                      type="button"
                      disabled={working || selectedIssue.disk.readOnly}
                      style={{ ...button, background: "#fed7aa" }}
                      onClick={() => void perform(() => dbtController(editor).resolve(selectedShape.id, "canvas"))}
                    >
                      Write canvas version to disk
                    </button>
                  </>
                )}
                <button
                  type="button"
                  style={button}
                  onClick={() => {
                    editor.select(selectedShape.id);
                    editor.zoomToSelection();
                    onClose();
                  }}
                >
                  Go to file
                </button>
                <button type="button" style={button} onClick={() => downloadDraft(selectedShape)}>
                  Download canvas copy
                </button>
                {selectedIssue?.kind === "duplicate" && (
                  <button
                    type="button"
                    style={button}
                    onClick={() => updateDbtFile(editor, selectedShape, { bindingId: "" })}
                  >
                    Detach this copy
                  </button>
                )}
              </div>
            </div>
          )}
          {!!state.project?.warnings.length && (
            <details style={{ fontSize: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 750 }}>
                Project notes ({state.project.warnings.length})
              </summary>
              <ul style={{ paddingLeft: 20, lineHeight: 1.6 }}>
                {state.project.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <div style={{ fontSize: 11, lineHeight: 1.7, color: "#475569" }}>
            Files save automatically after editing. New files on disk appear within a few seconds. Removed files keep
            their canvas copy; deleting a linked node restores it on the next sync. Run models using their SQL node’s
            Run button, then create tables, charts, or exploratory queries. Previews do not materialize warehouse
            models. This connection belongs to this canvas on this machine.
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
