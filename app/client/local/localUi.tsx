import { memo, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  CenteredTopPanelContainer,
  DefaultKeyboardShortcutsDialog,
  DefaultKeyboardShortcutsDialogContent,
  DefaultMainMenu,
  DefaultToolbar,
  DefaultToolbarContent,
  EditSubmenu,
  KeyboardShortcutsMenuItem,
  LanguageMenu,
  OfflineIndicator,
  TldrawUiMenuActionItem,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  TldrawUiToolbar,
  ToggleDebugModeItem,
  ToggleDynamicSizeModeItem,
  ToggleEdgeScrollingItem,
  ToggleFocusModeItem,
  ToggleGridItem,
  TogglePasteAtCursorItem,
  ToggleSnapModeItem,
  ToggleToolLockItem,
  ToggleWrapModeItem,
  ViewSubmenu,
  type TLComponents,
  type TLUiOverrides,
  useBreakpoint,
  useEditor,
  useIsToolSelected,
  usePassThroughWheelEvents,
  useTldrawUiComponents,
  useTools,
  useTranslation,
  useValue,
} from "tldraw";
import { useCliStatus } from "../localServer/runtimeStore";
import { Asterisk, Database, FilePlus2, FileTerminal, FolderOpen, Loader2, Save } from "lucide-react";
import { LocalRoomInfoPanel } from "./LocalRoomInfoPanel";
import { LocalSaveDialog } from "./LocalSaveDialog";
import { LocalSourcesDialog } from "./LocalSourcesDialog";
import type { SaveLocalSessionOptions, SaveLocalSessionResult } from "./localSession";

export const localUiOverrides: TLUiOverrides = {
  tools(editor, tools) {
    tools["sql-text-area"] = {
      id: "sql-text-area",
      icon: "sql",
      label: "sql-text-area",
      kbd: "c",
      onSelect: () => editor.setCurrentTool("sql-text-area"),
    };
    tools["data-source"] = {
      id: "data-source",
      icon: "source",
      label: "data-source",
      kbd: "s",
      onSelect: () => editor.setCurrentTool("data-source"),
    };
    return tools;
  },
};

function CanvasHeader({
  documentName,
  isDocumentDirty,
  isDocumentSaving,
}: {
  documentName: string;
  isDocumentDirty: boolean;
  isDocumentSaving: boolean;
}) {
  return (
    <div className="pointer-events-none">
      <div
        className="flex w-fit items-center space-x-2 whitespace-nowrap border-b-2 border-r-2 border-black bg-violet-300 py-2 pl-3 pr-8"
        style={{ borderRadius: "0 0 12px 0" }}
      >
        <img src="/kavla.svg" alt="Kavla Logo" className="h-6 w-6 flex-shrink-0" />
        <span className="font-bold">Kavla</span>
        <span className="font-bold opacity-50">/</span>
        <span className="flex items-center font-bold">
          {documentName}
          {isDocumentSaving ? (
            <Loader2 aria-label="Saving document" className="ml-1 animate-spin" size={12} strokeWidth={3} />
          ) : isDocumentDirty ? (
            <Asterisk aria-label="Unsaved changes" className="ml-0.5" size={13} strokeWidth={3} />
          ) : null}
        </span>
      </div>
    </div>
  );
}

type LocalDocumentControlsProps = {
  documentName: string;
  documentsAvailable: boolean;
  onLoadDocument: (path: string) => Promise<void>;
  onNewDocument: (options: SaveLocalSessionOptions) => Promise<SaveLocalSessionResult>;
  onSaveDocument: () => Promise<void>;
};

function LocalDocumentControls({
  documentName,
  documentsAvailable,
  onLoadDocument,
  onNewDocument,
  onSaveDocument,
}: LocalDocumentControlsProps) {
  const [dialogMode, setDialogMode] = useState<"load" | "new" | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSaveDocument();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="kavla-document-controls"
      style={{
        backgroundColor: "#ede9fe",
        borderBottom: "2px solid #000",
        borderRadius: "0 0 10px 0",
        borderRight: "2px solid #000",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        pointerEvents: "all",
        width: "fit-content",
      }}
    >
      <style>
        {`
          .kavla-document-control {
            align-items: center;
            background: transparent;
            border: 0;
            border-bottom: 2px solid #000;
            color: #000;
            cursor: pointer;
            display: flex;
            font-family: Inter, sans-serif;
            font-size: 11px;
            font-weight: 850;
            gap: 5px;
            height: 28px;
            justify-content: flex-start;
            padding: 0 7px;
            transition: background-color 100ms ease, transform 100ms ease;
            width: 86px;
          }
          .kavla-document-control > svg { flex-shrink: 0; }
          .kavla-document-control:last-of-type { border-bottom: 0; }
          .kavla-document-control[data-action="new"] { background: #fef3c7; }
          .kavla-document-control[data-action="save"] { background: #fce7f3; }
          .kavla-document-control[data-action="load"] { background: #dcfce7; }
          .kavla-document-control[data-action="sources"] { background: #dbeafe; }
          .kavla-document-control[data-action="new"]:hover { background: #fde68a; }
          .kavla-document-control[data-action="save"]:hover { background: #fbcfe8; }
          .kavla-document-control[data-action="load"]:hover { background: #bbf7d0; }
          .kavla-document-control[data-action="sources"]:hover { background: #bfdbfe; }
          .kavla-document-control:active { transform: translateY(1px); }
          .kavla-document-control:disabled { cursor: default; opacity: 0.42; }
        `}
      </style>
      <button
        aria-label="New Kavla document"
        className="kavla-document-control"
        data-action="new"
        disabled={!documentsAvailable}
        onClick={() => setDialogMode("new")}
        onPointerDown={(event) => event.stopPropagation()}
        title={documentsAvailable ? "Create a new .kavla document" : "Run Kavla through the CLI to create documents"}
        type="button"
      >
        <FilePlus2 size={14} />
        New
      </button>
      <button
        aria-label="Save Kavla document"
        className="kavla-document-control"
        data-action="save"
        disabled={!documentsAvailable || saving}
        onClick={() => void save()}
        onPointerDown={(event) => event.stopPropagation()}
        title={documentsAvailable ? "Save this .kavla document (Ctrl/⌘+S)" : "Run Kavla through the CLI to save"}
        type="button"
      >
        {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />}
        Save
      </button>
      <button
        aria-label="Load Kavla document"
        className="kavla-document-control"
        data-action="load"
        disabled={!documentsAvailable}
        onClick={() => setDialogMode("load")}
        onPointerDown={(event) => event.stopPropagation()}
        title={documentsAvailable ? "Load a .kavla document" : "Run Kavla through the CLI to load"}
        type="button"
      >
        <FolderOpen size={14} />
        Load
      </button>
      <button
        aria-label="Configure Kavla sources"
        className="kavla-document-control"
        data-action="sources"
        disabled={!documentsAvailable}
        onClick={() => setShowSources(true)}
        onPointerDown={(event) => event.stopPropagation()}
        title={documentsAvailable ? "Configure data sources" : "Run Kavla through the CLI to configure sources"}
        type="button"
      >
        <Database size={14} />
        Sources
      </button>
      {dialogMode ? (
        <LocalSaveDialog
          documentName={documentName}
          mode={dialogMode}
          onClose={() => setDialogMode(null)}
          onLoad={onLoadDocument}
          onSave={dialogMode === "new" ? onNewDocument : undefined}
        />
      ) : null}
      {showSources ? <LocalSourcesDialog onClose={() => setShowSources(false)} /> : null}
    </div>
  );
}

const LocalMenuPanel = memo(function LocalMenuPanel({
  documentName,
  documentsAvailable,
  isDocumentDirty,
  isDocumentSaving,
  onLoadDocument,
  onNewDocument,
  onSaveDocument,
}: { documentName: string; isDocumentDirty: boolean; isDocumentSaving: boolean } & LocalDocumentControlsProps) {
  const breakpoint = useBreakpoint();
  const msg = useTranslation();
  const editor = useEditor();
  const ref = useRef<any>(null);
  usePassThroughWheelEvents(ref);

  const { MainMenu, QuickActions, ActionsMenu, PageMenu } = useTldrawUiComponents();
  const isSinglePageMode = useValue("isSinglePageMode", () => editor.options.maxPages <= 1, [editor]);
  const showQuickActions =
    editor.options.actionShortcutsLocation === "menu"
      ? true
      : editor.options.actionShortcutsLocation === "toolbar"
        ? false
        : breakpoint >= 768;

  return (
    <div>
      <CanvasHeader documentName={documentName} isDocumentDirty={isDocumentDirty} isDocumentSaving={isDocumentSaving} />
      <LocalDocumentControls
        documentName={documentName}
        documentsAvailable={documentsAvailable}
        onLoadDocument={onLoadDocument}
        onNewDocument={onNewDocument}
        onSaveDocument={onSaveDocument}
      />
      {(MainMenu || PageMenu || showQuickActions) && (
        <nav ref={ref} className="tlui-menu-zone">
          <div className="tlui-row">
            {MainMenu && <MainMenu />}
            {PageMenu && !isSinglePageMode && <PageMenu />}
            {showQuickActions && (
              <TldrawUiToolbar label={msg("actions-menu.title")}>
                {QuickActions && <QuickActions />}
                {ActionsMenu && <ActionsMenu />}
              </TldrawUiToolbar>
            )}
          </div>
        </nav>
      )}
    </div>
  );
});

function CustomMainMenu() {
  return (
    <DefaultMainMenu>
      <TldrawUiMenuGroup id="basic">
        <EditSubmenu />
        <ViewSubmenu />
        <TldrawUiMenuActionItem actionId="insert-media" />
      </TldrawUiMenuGroup>
      <TldrawUiMenuGroup id="preferences">
        <TldrawUiMenuSubmenu id="preferences" label="menu.preferences">
          <TldrawUiMenuGroup id="preferences-actions">
            <ToggleSnapModeItem />
            <ToggleToolLockItem />
            <ToggleGridItem />
            <ToggleWrapModeItem />
            <ToggleFocusModeItem />
            <ToggleEdgeScrollingItem />
            <ToggleDynamicSizeModeItem />
            <TogglePasteAtCursorItem />
            <ToggleDebugModeItem />
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
        <LanguageMenu />
        <KeyboardShortcutsMenuItem />
      </TldrawUiMenuGroup>
    </DefaultMainMenu>
  );
}

function LocalToolbar(props: ComponentProps<typeof DefaultToolbar>) {
  const tools = useTools();
  const sourceSelected = useIsToolSelected(tools["data-source"]);
  const sqlSelected = useIsToolSelected(tools["sql-text-area"]);

  return (
    <DefaultToolbar {...props}>
      <div className="custom-data-tools" style={{ display: "flex", pointerEvents: "all", position: "relative" }}>
        <style>
          {`
            .tlui-popover__content .custom-data-tools { display: none !important; }
            button[data-testid="tools.data-source"],
            button[data-testid="tools.sql-text-area"] {
              width: 48px !important;
              height: 48px !important;
              border-radius: 9px !important;
            }
            button[data-testid="tools.data-source"] { background-color: #eff6ff !important; }
            button[data-testid="tools.data-source"]:hover { background-color: #bfdbfe !important; }
            button[data-testid="tools.sql-text-area"] { background-color: #fefce8 !important; }
            button[data-testid="tools.sql-text-area"]:hover { background-color: #fef08a !important; }
            button[data-testid="tools.data-source"] .tlui-icon,
            button[data-testid="tools.sql-text-area"] .tlui-icon { display: none !important; }
            .data-tool-wrapper button::before,
            .data-tool-wrapper button::after { background: transparent !important; }
            .data-tool-wrapper.data-tool-selected button {
              background-color: var(--color-selected, #3b82f6) !important;
            }
            @media (max-width: 840px) {
              button[data-testid="tools.eraser"],
              button[data-testid="tools.arrow"] { display: none !important; }
            }
          `}
        </style>
        <div
          style={{
            position: "absolute",
            top: -20,
            left: 0,
            width: "100%",
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 20,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "black",
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
              backgroundColor: "#fde047",
              border: "2px solid black",
              borderRadius: 4,
              padding: "2px 6px",
              transform: "rotate(-2deg)",
              boxShadow: "2px 2px 0 0 #000",
              fontFamily: "monospace",
            }}
          >
            Data Tools
          </div>
        </div>

        <DataToolButton tool={tools["data-source"]} selected={sourceSelected} color="#2563eb" label="Source">
          <Database size={20} strokeWidth={2} />
        </DataToolButton>
        <DataToolButton tool={tools["sql-text-area"]} selected={sqlSelected} color="#854d0e" label="Query">
          <FileTerminal size={20} strokeWidth={2} />
        </DataToolButton>
        <div
          style={{ width: 1, height: 32, backgroundColor: "var(--color-border)", margin: "0 4px", alignSelf: "center" }}
        />
      </div>
      <DefaultToolbarContent />
    </DefaultToolbar>
  );
}

function DataToolButton({
  tool,
  selected,
  color,
  label,
  children,
}: {
  tool: ComponentProps<typeof TldrawUiMenuItem>;
  selected: boolean;
  color: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={`data-tool-wrapper ${selected ? "data-tool-selected" : ""}`} style={{ position: "relative" }}>
      <TldrawUiMenuItem {...tool} isSelected={selected} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          gap: 2,
          color: selected ? "#fff" : color,
          zIndex: 10,
        }}
      >
        {children}
        <span style={{ fontSize: 10, fontWeight: 700, lineHeight: 1 }}>{label}</span>
      </div>
    </div>
  );
}

function LocalConnectionStatus() {
  const cliConnected = useCliStatus();

  return <CenteredTopPanelContainer>{!cliConnected && <OfflineIndicator />}</CenteredTopPanelContainer>;
}

export function useLocalComponents({
  documentName,
  documentsAvailable,
  fileSize,
  isDocumentDirty,
  isDocumentSaving,
  onLoadDocument,
  onNewDocument,
  onSaveDocument,
}: {
  documentName: string;
  isDocumentDirty: boolean;
  isDocumentSaving: boolean;
  fileSize: number | null;
} & LocalDocumentControlsProps): TLComponents {
  return useMemo(
    () => ({
      Toolbar: LocalToolbar,
      KeyboardShortcutsDialog: (props) => {
        const tools = useTools();
        return (
          <DefaultKeyboardShortcutsDialog {...props}>
            <TldrawUiMenuItem {...tools["data-source"]} />
            <TldrawUiMenuItem {...tools["sql-text-area"]} />
            <DefaultKeyboardShortcutsDialogContent />
          </DefaultKeyboardShortcutsDialog>
        );
      },
      MenuPanel: () => (
        <LocalMenuPanel
          documentName={documentName}
          documentsAvailable={documentsAvailable}
          isDocumentDirty={isDocumentDirty}
          isDocumentSaving={isDocumentSaving}
          onLoadDocument={onLoadDocument}
          onNewDocument={onNewDocument}
          onSaveDocument={onSaveDocument}
        />
      ),
      SharePanel: () => <LocalRoomInfoPanel fileSize={fileSize} />,
      MainMenu: CustomMainMenu,
      PageMenu: null,
      TopPanel: LocalConnectionStatus,
      InFrontOfTheCanvas: null,
    }),
    [
      documentName,
      documentsAvailable,
      fileSize,
      isDocumentDirty,
      isDocumentSaving,
      onLoadDocument,
      onNewDocument,
      onSaveDocument,
    ]
  );
}
