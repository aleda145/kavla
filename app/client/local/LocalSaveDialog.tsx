import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { ChevronUp, FilePlus2, FileText, Folder, FolderOpen, Home, Loader2, Save, X } from "lucide-react";
import { useToasts } from "tldraw";
import {
  KavlaSaveConflictError,
  listLocalSessionDirectory,
  type KavlaDirectoryListing,
  type SaveLocalSessionOptions,
  type SaveLocalSessionResult,
} from "./localSession";

type LocalSaveDialogProps = {
  documentName: string;
  mode: "save" | "load" | "new";
  onClose: () => void;
  onLoad?: (path: string) => Promise<void>;
  onSave?: (options: SaveLocalSessionOptions) => Promise<SaveLocalSessionResult>;
};

function kavlaFileName(documentName: string): string {
  return `${documentName.trim() || "untitled"}.kavla`;
}

function nextNewCanvasFileName(listing: KavlaDirectoryListing): string {
  const documentNames = new Set(listing.entries.map((entry) => entry.name.toLocaleLowerCase()));
  let suffix = 0;
  while (true) {
    const fileName = suffix === 0 ? "new_canvas.kavla" : `new_canvas_${suffix}.kavla`;
    if (!documentNames.has(fileName)) return fileName;
    suffix += 1;
  }
}

export function LocalSaveDialog({ documentName, mode, onClose, onLoad, onSave }: LocalSaveDialogProps) {
  const [listing, setListing] = useState<KavlaDirectoryListing | null>(null);
  const [fileName, setFileName] = useState(() => (mode === "new" ? "new_canvas.kavla" : kavlaFileName(documentName)));
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToasts();

  const entries = useMemo(
    () =>
      [...(listing?.entries ?? [])].sort((left, right) => {
        if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
    [listing?.entries]
  );

  const openDirectory = async (path?: string): Promise<KavlaDirectoryListing | null> => {
    setLoadingDirectory(true);
    setError(null);
    try {
      const nextListing = await listLocalSessionDirectory(path);
      setListing(nextListing);
      if (mode === "new") {
        setFileName(nextNewCanvasFileName(nextListing));
      }
      return nextListing;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return null;
    } finally {
      setLoadingDirectory(false);
    }
  };

  useEffect(() => {
    void openDirectory();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const confirmSelection = async (overwrite: boolean) => {
    if (mode === "load") {
      if (!selectedDocumentPath || !onLoad) return;
      const confirmed = window.confirm("Load this document? Unsaved changes in the current canvas will be replaced.");
      if (!confirmed) return;
      setSaving(true);
      setError(null);
      try {
        await onLoad(selectedDocumentPath);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
        setSaving(false);
      }
      return;
    }
    if (!listing || !fileName.trim() || !onSave) return;
    const normalizedFileName = fileName.trim().toLowerCase().endsWith(".kavla")
      ? fileName.trim()
      : `${fileName.trim()}.kavla`;
    setFileName(normalizedFileName);
    setSaving(true);
    setError(null);
    try {
      const result = await onSave({ directory: listing.path, fileName: normalizedFileName, overwrite });
      if (mode === "save") {
        addToast({ title: "Saved", description: result.path, severity: "success" });
        onClose();
      }
    } catch (nextError) {
      if (nextError instanceof KavlaSaveConflictError && !overwrite) {
        const confirmed = window.confirm(`${normalizedFileName} already exists. Replace it?`);
        if (confirmed) {
          setSaving(false);
          await confirmSelection(true);
          return;
        }
      } else {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    } finally {
      setSaving(false);
    }
  };

  const title =
    mode === "save" ? "Save Kavla document" : mode === "load" ? "Load Kavla document" : "New Kavla document";
  const actionLabel = mode === "save" ? "Save here" : mode === "load" ? "Load selected" : "Create here";
  const actionIcon =
    mode === "save" ? <Save size={15} /> : mode === "load" ? <FolderOpen size={15} /> : <FilePlus2 size={15} />;
  const actionDisabled =
    loadingDirectory || saving || (mode === "load" ? !selectedDocumentPath : !listing || !fileName.trim());

  return createPortal(
    <div
      aria-label={title}
      aria-modal="true"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      role="dialog"
      style={{
        alignItems: "center",
        backgroundColor: "rgba(15, 23, 42, 0.32)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 20,
        pointerEvents: "all",
        position: "fixed",
        zIndex: 1_000_000,
      }}
    >
      <div
        style={{
          backgroundColor: "#fff",
          border: "3px solid #000",
          borderRadius: 12,
          boxShadow: "6px 6px 0 0 #000",
          color: "#000",
          display: "flex",
          flexDirection: "column",
          fontFamily: "Inter, sans-serif",
          maxHeight: "min(680px, calc(100vh - 40px))",
          overflow: "hidden",
          width: "min(620px, calc(100vw - 40px))",
        }}
      >
        <div
          style={{
            alignItems: "center",
            backgroundColor: mode === "load" ? "#dcfce7" : mode === "new" ? "#fef3c7" : "#dcfce7",
            borderBottom: "3px solid #000",
            display: "flex",
            justifyContent: "space-between",
            padding: "11px 14px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", fontSize: 14, fontWeight: 900, gap: 8 }}>
            {mode === "save" ? (
              <Save size={18} strokeWidth={2.5} />
            ) : mode === "load" ? (
              <FolderOpen size={18} strokeWidth={2.5} />
            ) : (
              <FilePlus2 size={18} strokeWidth={2.5} />
            )}
            {title}
          </div>
          <button
            aria-label="Close save dialog"
            disabled={saving}
            onClick={onClose}
            style={{ background: "transparent", border: 0, cursor: "pointer", display: "flex", padding: 2 }}
            type="button"
          >
            <X size={19} strokeWidth={3} />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, padding: 14 }}>
          <div style={{ alignItems: "center", display: "flex", gap: 7 }}>
            <button
              aria-label="Home directory"
              disabled={!listing?.homePath || loadingDirectory}
              onClick={() => void openDirectory(listing?.homePath)}
              style={navigationButtonStyle}
              title="Home directory"
              type="button"
            >
              <Home size={15} />
            </button>
            <button
              aria-label="Parent directory"
              disabled={!listing?.parentPath || loadingDirectory}
              onClick={() => void openDirectory(listing?.parentPath)}
              style={navigationButtonStyle}
              title="Parent directory"
              type="button"
            >
              <ChevronUp size={17} />
            </button>
            <div
              title={listing?.path}
              style={{
                backgroundColor: "#f8fafc",
                border: "2px solid #000",
                borderRadius: 7,
                flex: 1,
                fontFamily: "monospace",
                fontSize: 11,
                fontWeight: 700,
                overflow: "hidden",
                padding: "7px 9px",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {listing?.path ?? "Opening directory…"}
            </div>
          </div>

          <div
            style={{
              backgroundColor: "#f8fafc",
              border: "2px solid #000",
              borderRadius: 8,
              flex: "1 1 300px",
              minHeight: 220,
              overflowY: "auto",
            }}
          >
            {loadingDirectory ? (
              <div style={emptyStateStyle}>
                <Loader2 className="animate-spin" size={22} /> Opening directory…
              </div>
            ) : entries.length === 0 ? (
              <div style={emptyStateStyle}>This directory has no folders or Kavla documents.</div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => {
                    if (entry.type === "directory") {
                      setSelectedDocumentPath(null);
                      void openDirectory(entry.path);
                    } else if (mode === "load") {
                      setSelectedDocumentPath(entry.path);
                    } else {
                      setFileName(entry.name);
                    }
                  }}
                  style={{
                    alignItems: "center",
                    backgroundColor:
                      entry.type !== "document"
                        ? "transparent"
                        : mode === "load" && entry.path === selectedDocumentPath
                          ? "#dcfce7"
                          : mode === "load" && entry.path === listing?.currentDocumentPath
                            ? "#fce7f3"
                            : mode !== "load" && entry.name === fileName
                              ? "#dbeafe"
                              : "transparent",
                    border: 0,
                    borderBottom: "1px solid #cbd5e1",
                    color: "#000",
                    cursor: "pointer",
                    display: "flex",
                    fontFamily: "Inter, sans-serif",
                    fontSize: 12,
                    fontWeight: 750,
                    gap: 9,
                    padding: "9px 11px",
                    textAlign: "left",
                    width: "100%",
                  }}
                  title={entry.path}
                  type="button"
                >
                  {entry.type === "directory" ? <Folder fill="#fde68a" size={17} /> : <FileText size={17} />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.name}
                  </span>
                </button>
              ))
            )}
          </div>

          {mode === "load" ? (
            <div style={{ fontSize: 11, fontWeight: 800 }}>
              {selectedDocumentPath ? `Selected: ${selectedDocumentPath}` : "Select a .kavla document from the list."}
            </div>
          ) : (
            <label style={{ display: "flex", flexDirection: "column", fontSize: 11, fontWeight: 900, gap: 5 }}>
              FILE NAME
              <input
                autoFocus
                disabled={saving}
                onChange={(event) => setFileName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !saving) void confirmSelection(false);
                }}
                spellCheck={false}
                style={{
                  border: "2px solid #000",
                  borderRadius: 7,
                  color: "#000",
                  fontFamily: "Inter, sans-serif",
                  fontSize: 13,
                  fontWeight: 700,
                  outline: "none",
                  padding: "8px 10px",
                }}
                value={fileName}
              />
            </label>
          )}

          {error ? (
            <div
              style={{
                backgroundColor: "#fee2e2",
                border: "2px solid #000",
                borderRadius: 7,
                fontSize: 11,
                fontWeight: 700,
                padding: "8px 10px",
              }}
            >
              {error}
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button disabled={saving} onClick={onClose} style={secondaryButtonStyle} type="button">
              Cancel
            </button>
            <button
              disabled={actionDisabled}
              onClick={() => void confirmSelection(false)}
              style={{
                ...primaryButtonStyle,
                backgroundColor: mode === "load" ? "#dcfce7" : mode === "new" ? "#fef3c7" : "#dcfce7",
                opacity: actionDisabled ? 0.5 : 1,
              }}
              type="button"
            >
              {saving ? <Loader2 className="animate-spin" size={15} /> : actionIcon}
              {actionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

const navigationButtonStyle = {
  alignItems: "center",
  backgroundColor: "#fff",
  border: "2px solid #000",
  borderRadius: 7,
  cursor: "pointer",
  display: "flex",
  height: 32,
  justifyContent: "center",
  width: 34,
};

const emptyStateStyle = {
  alignItems: "center",
  color: "#475569",
  display: "flex",
  fontSize: 12,
  fontWeight: 700,
  gap: 8,
  height: "100%",
  justifyContent: "center",
  minHeight: 220,
  padding: 20,
  textAlign: "center" as const,
};

const secondaryButtonStyle = {
  backgroundColor: "#fff",
  border: "2px solid #000",
  borderRadius: 7,
  boxShadow: "2px 2px 0 0 rgba(0,0,0,0.2)",
  color: "#000",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 800,
  padding: "8px 13px",
};

const primaryButtonStyle = {
  alignItems: "center",
  backgroundColor: "#dcfce7",
  border: "2px solid #000",
  borderRadius: 7,
  boxShadow: "3px 3px 0 0 #000",
  color: "#000",
  cursor: "pointer",
  display: "flex",
  fontSize: 12,
  fontWeight: 900,
  gap: 6,
  padding: "8px 13px",
};
