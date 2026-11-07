import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, Files, Loader2, Trash2, X } from "lucide-react";
import { useEditor, useValue, type Editor, type TLAsset, type TLShapeId } from "tldraw";
import type { DataSourceShape } from "../../DataSource/data-source-types";
import { backendRequest, withBackendActivity } from "../backendCompute";
import { deleteSessionBlob, type KavlaBlobDescriptor, type KavlaLocalSession } from "./localSession";

type CanvasAsset = {
  id: string;
  name: string;
  kind: string;
  size: number | undefined;
  blob?: KavlaBlobDescriptor;
  asset?: TLAsset;
  shapeIds: TLShapeId[];
};

function getCanvasAssets(editor: Editor, blobs: KavlaBlobDescriptor[]): CanvasAsset[] {
  const shapes = Object.values(editor.store.serialize("document")).filter((record) => record.typeName === "shape");
  const assets = editor.getAssets();
  const bundledAssetIds = new Set<string>();
  const rows: CanvasAsset[] = blobs.map((blob) => {
    const asset = blob.kind === "asset" ? assets.find((entry) => entry.id === blob.shapeId) : undefined;
    if (asset) bundledAssetIds.add(asset.id);
    const shapeIds = shapes
      .filter((shape) => {
        if (blob.kind === "asset")
          return !!blob.shapeId && "assetId" in shape.props && shape.props.assetId === blob.shapeId;
        if (blob.tableName && shape.type === "data-source") {
          return (shape as DataSourceShape).props.remoteTableRef === `uploaded_files.main.${blob.tableName}`;
        }
        return shape.id === blob.shapeId;
      })
      .map((shape) => shape.id);
    return {
      id: blob.id,
      name: blob.fileName,
      kind: blob.kind === "source" ? "Uploaded file" : (asset?.type ?? blob.mimeType ?? "Asset"),
      size: blob.size,
      blob,
      asset,
      shapeIds,
    };
  });

  for (const asset of assets) {
    if (bundledAssetIds.has(asset.id)) continue;
    rows.push({
      id: asset.id,
      name: asset.type === "bookmark" ? asset.props.title || asset.props.src || "Bookmark" : asset.props.name,
      kind: asset.type,
      size: asset.type === "bookmark" ? undefined : asset.props.fileSize,
      asset,
      shapeIds: shapes
        .filter((shape) => "assetId" in shape.props && shape.props.assetId === asset.id)
        .map((shape) => shape.id),
    });
  }
  return rows.sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.name.localeCompare(b.name));
}

function formatAssetSize(size: number | undefined): string {
  if (size === undefined || size < 0) return "Size unknown";
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

const actionClass =
  "inline-flex items-center justify-center gap-1.5 rounded border-2 border-black bg-white px-2 py-1.5 text-xs font-bold shadow-[2px_2px_0_0_rgba(0,0,0,0.2)] enabled:cursor-pointer enabled:hover:shadow-[3px_3px_0_0_#000] disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400 disabled:shadow-none";

export function LocalAssetsDialog({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const [blobs, setBlobs] = useState<KavlaBlobDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const rows = useValue("canvas assets", () => getCanvasAssets(editor, blobs), [editor, blobs]);
  const readonly = useValue("assets readonly", () => editor.getIsReadonly(), [editor]);
  const busy = deletingId !== null;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    dialogRef.current?.focus();
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("kavla:uploads-changed", refresh);
    return () => {
      window.removeEventListener("kavla:uploads-changed", refresh);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void backendRequest("/api/session")
      .then((response) => response.json() as Promise<KavlaLocalSession>)
      .then((session) => {
        if (!cancelled) {
          setBlobs(session.blobs);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const viewAsset = (row: CanvasAsset) => {
    const shapeId = row.shapeIds.find((id) => editor.getShape(id));
    const pageId = shapeId && editor.getAncestorPageId(shapeId);
    if (!shapeId || !pageId) return;
    editor.setCurrentPage(pageId);
    editor.select(...row.shapeIds.filter((id) => editor.getAncestorPageId(id) === pageId));
    editor.zoomToSelection({ animation: { duration: 250 } });
    onClose();
  };

  const deleteAsset = async (row: CanvasAsset) => {
    if (busyRef.current || loading || loadError || editor.getIsReadonly()) return;
    const details = row.blob?.kind === "source" ? " Queries using this file will no longer work." : "";
    if (
      !window.confirm(
        `Delete ${row.name} from this document and remove its canvas shapes?${details} This cannot be undone.`
      )
    )
      return;
    busyRef.current = true;
    setDeletingId(row.id);
    setError(null);
    try {
      await withBackendActivity(async () => {
        if (row.blob) await deleteSessionBlob(row.blob);
        // Read references again after the request, including shapes on other pages.
        const current = getCanvasAssets(editor, row.blob ? [row.blob] : []).find((entry) => entry.id === row.id);
        editor.run(
          () => {
            editor.deleteShapes(current?.shapeIds ?? []);
            // The bundled file has already been deleted and its errors handled above.
            // deleteAssets would start another, unawaited asset-store deletion.
            if (row.asset) editor.store.remove([row.asset.id]);
          },
          { history: "ignore", ignoreShapeLock: true }
        );
        setBlobs((entries) => entries.filter((blob) => blob.id !== row.blob?.id));
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      setDeletingId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-slate-900/30 p-5"
      style={{ zIndex: 1_000_000, pointerEvents: "all", fontFamily: "Inter, sans-serif" }}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !busy) onClose();
        if (event.key !== "Tab") return;
        const elements = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
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
        aria-labelledby="canvas-assets-title"
        aria-busy={loading || busy}
        className="flex max-h-[85vh] w-[680px] max-w-full flex-col overflow-hidden rounded-xl border-[3px] border-black bg-white text-black shadow-[4px_4px_0_0_#000] outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b-[3px] border-black bg-blue-100 px-4 py-3">
          <h2 id="canvas-assets-title" className="flex items-center gap-2 font-black">
            <Files size={18} /> Canvas assets
          </h2>
          <button type="button" aria-label="Close assets" disabled={busy} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 p-6 text-sm">
              <Loader2 className="animate-spin" size={18} /> Loading assets…
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="break-words text-sm font-bold">{row.name}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    <span className="capitalize">{row.kind}</span> · {formatAssetSize(row.size)}
                    {row.shapeIds.length === 0 && " · Not on canvas"}
                  </p>
                  {row.blob?.tableName && (
                    <p className="mt-1 break-all text-xs text-slate-500">uploaded_files.main.{row.blob.tableName}</p>
                  )}
                </div>
                <button
                  type="button"
                  className={actionClass}
                  disabled={busy || row.shapeIds.length === 0}
                  title={row.shapeIds.length === 0 ? "This asset is no longer on the canvas" : "View on canvas"}
                  aria-label={`View ${row.name} on canvas`}
                  onClick={() => viewAsset(row)}
                >
                  <Eye size={14} /> View
                </button>
                <button
                  type="button"
                  className={`${actionClass} enabled:bg-red-50`}
                  disabled={busy || readonly || loadError !== null}
                  aria-label={`Delete ${row.name}`}
                  onClick={() => void deleteAsset(row)}
                >
                  {deletingId === row.id ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />} Delete
                </button>
              </div>
            ))
          )}
        </div>
        {loadError && (
          <div role="alert" className="mx-4 my-2 rounded border-2 border-black bg-red-100 p-3 text-xs">
            <p>{loadError}</p>
            <button
              type="button"
              className={`${actionClass} mt-2`}
              onClick={() => {
                setLoading(true);
                setRevision((value) => value + 1);
              }}
            >
              Retry loading assets
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="mx-4 my-2 rounded border-2 border-black bg-red-100 p-3 text-xs">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}
