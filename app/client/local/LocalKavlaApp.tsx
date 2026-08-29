import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import {
  defaultShapeUtils,
  Editor,
  getUserPreferences,
  setUserPreferences,
  Tldraw,
  TLUiAssetUrlOverrides,
  useToasts,
} from "tldraw";
import { ChartUtil } from "../../Chart/ChartUtil";
import { CLITerminalUtil } from "../../CLITerminal/CLITerminalUtil";
import { DataSourceUtil } from "../../DataSource/DataSourceUtil";
import { SQLResultTableUtil } from "../../SQLResultArea/SQLResultAreaUtil";
import { SQLTextAreaTool } from "../../SQLTextArea/SQLTextAreaTool";
import { SQLTextAreaUtil } from "../../SQLTextArea/SQLTextAreaUtil";
import source from "../../util/source.svg";
import sql from "../../util/sql.svg";
import { SourceTextAreaTool } from "../../DataSource/DataSourceTool";
import { KavlaArrowBindingUtil, KavlaArrowShapeUtil } from "../KavlaArrowShapeUtil";
import { getBookmarkAsset } from "../getBookmarkAsset";
import { enableRightClickDragPan } from "../canvas/enableRightClickDragPan";
import { useCanvasFileDrop } from "../canvas/useCanvasFileDrop";
import { LocalServerProvider, useData } from "../useLocalServer";
import { localUiOverrides, useLocalComponents } from "./localUi";
import {
  closeLocalSession,
  discoverLocalSession,
  loadCanvasJson,
  loadLocalSessionPath,
  newLocalSession,
  saveLocalSession,
  type SaveLocalSessionOptions,
  type SaveLocalSessionResult,
  stageCanvas,
  type KavlaLocalSession,
} from "./localSession";
import { localAssetStore } from "./localAssetStore";
import { handleLocalShapeDeleted } from "./handleLocalShapeDeleted";
import { getUniqueName } from "../../util/getUniqueName";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";

const customShapeUtils = [
  SQLTextAreaUtil,
  SQLResultTableUtil,
  DataSourceUtil,
  ChartUtil,
  CLITerminalUtil,
  KavlaArrowShapeUtil,
];

const localShapeUtils = [...customShapeUtils, ...defaultShapeUtils.filter((util) => util.type !== "arrow")];
const customTools = [SQLTextAreaTool, SourceTextAreaTool];
const bundledTldrawAssetUrls = getAssetUrlsByImport();
const customAssetUrls: TLUiAssetUrlOverrides = {
  ...bundledTldrawAssetUrls,
  icons: {
    ...bundledTldrawAssetUrls.icons,
    sql,
    source,
  },
};

function createEmptyCanvasJson(editor: Editor): string {
  const records = Object.values(editor.store.serialize("document")).filter(
    (record) => record.typeName !== "shape" && record.typeName !== "binding" && record.typeName !== "asset"
  );
  return JSON.stringify({
    tldrawFileFormatVersion: 1,
    schema: editor.store.schema.serialize(),
    records,
  });
}

const CANVAS_STAGE_IDLE_MS = 2_000;

function SessionLifecycle({ session }: { session: KavlaLocalSession | null }) {
  const [isDocumentDirty, setIsDocumentDirty] = useState(false);
  const [isDocumentSaving, setIsDocumentSaving] = useState(false);
  const [documentFileSize, setDocumentFileSize] = useState<number | null>(session?.fileSize ?? null);
  const editorRef = useRef<Editor | null>(null);
  const rightDragCleanupRef = useRef<(() => void) | null>(null);
  const storeCleanupRef = useRef<(() => void) | null>(null);
  const shapeSideEffectCleanupRef = useRef<(() => void)[]>([]);
  const saveTimerRef = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const loadingDocumentRef = useRef(false);
  const documentRevisionRef = useRef(0);
  const { addToast } = useToasts();
  const { deleteShapes } = useData();

  useCanvasFileDrop(editorRef, addToast);

  const stageCurrentCanvas = useCallback(
    async (includeCurrentCamera = false) => {
      const editor = editorRef.current;
      if (!editor || !session) return;
      await stageCanvas(editor, includeCurrentCamera);
    },
    [session]
  );

  const saveCurrentSession = useCallback(async () => {
    if (!session) {
      addToast({
        title: "CLI required",
        description: "Run Kavla through the CLI to save .kavla documents.",
        severity: "warning",
      });
      return;
    }
    const revisionBeingSaved = documentRevisionRef.current;
    setIsDocumentSaving(true);
    try {
      await stageCurrentCanvas(true);
      const savedDocument = await saveLocalSession();
      setDocumentFileSize(savedDocument?.fileSize ?? null);
      if (documentRevisionRef.current === revisionBeingSaved) {
        setIsDocumentDirty(false);
      }
      addToast({ title: "Saved", description: session.documentName, severity: "success" });
    } catch (error) {
      addToast({
        title: "Save failed",
        description: error instanceof Error ? error.message : String(error),
        severity: "error",
      });
    } finally {
      setIsDocumentSaving(false);
    }
  }, [addToast, session, stageCurrentCanvas]);

  const loadDocument = useCallback(
    async (path: string) => {
      if (!session) {
        throw new Error("Run Kavla through the CLI to load .kavla documents.");
      }
      loadingDocumentRef.current = true;
      try {
        await loadLocalSessionPath(path);
        window.location.reload();
      } catch (error) {
        loadingDocumentRef.current = false;
        throw error;
      }
    },
    [session]
  );

  const newDocument = useCallback(
    async (options: SaveLocalSessionOptions) => {
      if (!session) {
        throw new Error("Run Kavla through the CLI to create .kavla documents.");
      }
      const editor = editorRef.current;
      if (!editor) {
        throw new Error("The Kavla canvas is not ready yet.");
      }
      const emptyCanvasJson = createEmptyCanvasJson(editor);
      loadingDocumentRef.current = true;
      try {
        const result = await newLocalSession(options, emptyCanvasJson);
        window.location.reload();
        return result;
      } catch (error) {
        loadingDocumentRef.current = false;
        throw error;
      }
    },
    [session]
  );

  useEffect(() => {
    const handleSave = async (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      await saveCurrentSession();
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, [saveCurrentSession]);

  useEffect(() => {
    const handlePageHide = () => {
      if (loadingDocumentRef.current) return;
      void stageCurrentCanvas()
        .catch((error) => console.error("Could not stage Kavla canvas before closing", error))
        .finally(() => void closeLocalSession());
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [stageCurrentCanvas]);

  const onMount = useCallback(
    async (editor: Editor) => {
      editorRef.current = editor;
      rightDragCleanupRef.current?.();
      rightDragCleanupRef.current = enableRightClickDragPan(editor);
      editor.registerExternalAssetHandler("url", getBookmarkAsset);

      if (session && !loadedRef.current) {
        loadedRef.current = true;
        if (session.canvasJson) {
          loadCanvasJson(editor, session.canvasJson);
        }
        await stageCurrentCanvas();
        if (!session.canvasJson) {
          const savedDocument = await saveLocalSession();
          setDocumentFileSize(savedDocument?.fileSize ?? null);
        }
      }

      for (const cleanup of shapeSideEffectCleanupRef.current) cleanup();
      shapeSideEffectCleanupRef.current = [
        editor.sideEffects.registerAfterDeleteHandler("shape", (shape) => {
          handleLocalShapeDeleted(editor, shape, deleteShapes);
        }),
        editor.sideEffects.registerBeforeCreateHandler("shape", (shape) => {
          let nextShape = shape;
          if ("name" in nextShape.props && typeof nextShape.props.name === "string") {
            nextShape = {
              ...nextShape,
              props: {
                ...nextShape.props,
                name: getUniqueName(editor, nextShape.props.name),
              },
            };
          }

          if (nextShape.type !== "sql-text-area") {
            return nextShape;
          }

          const props = nextShape.props as SQLTextAreaShape["props"] & { _isProgrammatic?: boolean };
          const { _isProgrammatic, ...sqlProps } = props;
          return {
            ...nextShape,
            props: {
              ...sqlProps,
              linkedTableId: null,
              error: null,
              isRunning: false,
              downstreamShapeIds: _isProgrammatic ? (sqlProps.downstreamShapeIds ?? null) : null,
              upstreamShapeIds: _isProgrammatic ? (sqlProps.upstreamShapeIds ?? null) : null,
              stale: false,
            },
          };
        }),
      ];

      storeCleanupRef.current?.();
      const queueCanvasStage = () => {
        if (!session) return;
        documentRevisionRef.current += 1;
        setIsDocumentDirty(true);
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void stageCurrentCanvas().catch((error) => {
            addToast({
              title: "Could not stage changes",
              description: error instanceof Error ? error.message : String(error),
              severity: "error",
            });
          });
        }, CANVAS_STAGE_IDLE_MS);
      };
      const cleanupDocumentListener = editor.store.listen(queueCanvasStage, {
        source: "user",
        scope: "document",
      });
      storeCleanupRef.current = cleanupDocumentListener;
    },
    [addToast, deleteShapes, session, stageCurrentCanvas]
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      storeCleanupRef.current?.();
      rightDragCleanupRef.current?.();
      for (const cleanup of shapeSideEffectCleanupRef.current) cleanup();
      shapeSideEffectCleanupRef.current = [];
    };
  }, []);

  return (
    <LocalCanvasMount
      documentFileSize={documentFileSize}
      isDocumentDirty={isDocumentDirty}
      isDocumentSaving={isDocumentSaving}
      onLoadDocument={loadDocument}
      onMount={onMount}
      onNewDocument={newDocument}
      onSaveDocument={saveCurrentSession}
      session={session}
    />
  );
}

function LocalCanvasMount({
  documentFileSize,
  isDocumentDirty,
  isDocumentSaving,
  onLoadDocument,
  onMount,
  onNewDocument,
  onSaveDocument,
  session,
}: {
  documentFileSize: number | null;
  isDocumentDirty: boolean;
  isDocumentSaving: boolean;
  onLoadDocument: (path: string) => Promise<void>;
  onMount: (editor: Editor) => void | Promise<void>;
  onNewDocument: (options: SaveLocalSessionOptions) => Promise<SaveLocalSessionResult>;
  onSaveDocument: () => Promise<void>;
  session: KavlaLocalSession | null;
}) {
  const components = useLocalComponents({
    fileSize: documentFileSize,
    documentName: session?.documentName ?? "Local canvas",
    documentsAvailable: session !== null,
    isDocumentDirty,
    isDocumentSaving,
    onLoadDocument,
    onNewDocument,
    onSaveDocument,
  });
  const bindingUtils = useMemo(() => [KavlaArrowBindingUtil], []);

  return (
    <Tldraw
      persistenceKey={`kavla-${session?.documentId ?? "browser"}`}
      onMount={(editor) => void onMount(editor)}
      shapeUtils={localShapeUtils}
      bindingUtils={bindingUtils}
      tools={customTools}
      overrides={localUiOverrides}
      components={components}
      assetUrls={customAssetUrls}
      assets={localAssetStore}
      options={{ actionShortcutsLocation: "menu", maxPages: 1 }}
    />
  );
}

export default function LocalKavlaApp() {
  const [session, setSession] = useState<KavlaLocalSession | null>(null);
  const [ready, setReady] = useState(false);
  const [initializationError, setInitializationError] = useState<string | null>(null);

  useEffect(() => {
    const preferences = { ...getUserPreferences(), colorScheme: "light" as const };
    setUserPreferences(preferences);
    discoverLocalSession()
      .then((nextSession) => {
        setSession(nextSession);
        setReady(true);
      })
      .catch((error) => {
        console.error("Could not initialize Kavla", error);
        setInitializationError(error instanceof Error ? error.message : String(error));
        setReady(true);
      });
  }, []);

  if (!ready) {
    return <div className="fixed inset-0 flex items-center justify-center bg-[#f8f7f4] font-bold">Opening Kavla…</div>;
  }

  if (initializationError) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#f8f7f4] p-8">
        <div className="max-w-xl rounded-xl border-4 border-black bg-red-100 p-6 shadow-[6px_6px_0_0_#000]">
          <h1 className="mb-2 text-xl font-black">Kavla could not open this document</h1>
          <p className="font-mono text-sm">{initializationError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0">
      <LocalServerProvider>
        <SessionLifecycle session={session} />
      </LocalServerProvider>
    </div>
  );
}
