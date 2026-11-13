import { Settings } from "lucide-react";
import {
  EditSubmenu,
  KeyboardShortcutsMenuItem,
  TldrawUiButton,
  TldrawUiDropdownMenuContent,
  TldrawUiDropdownMenuRoot,
  TldrawUiDropdownMenuTrigger,
  TldrawUiMenuActionItem,
  TldrawUiMenuContextProvider,
  TldrawUiMenuGroup,
  ToggleDebugModeItem,
  ViewSubmenu,
  useEditor,
  useValue,
} from "tldraw";
import { JustIconsMenuItem } from "./justIcons";
import { getLayoutInProgress } from "./canvas/layoutActions";

export function CanvasSettingsMenu() {
  const editor = useEditor();
  const layoutDisabled = useValue(
    "Layout actions disabled",
    () => editor.getIsReadonly() || getLayoutInProgress(editor).get(),
    [editor]
  );
  return (
    <TldrawUiDropdownMenuRoot id="main menu">
      <TldrawUiDropdownMenuTrigger>
        <TldrawUiButton
          type="icon"
          className="kavla-settings-trigger"
          data-testid="main-menu.button"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={14} aria-hidden="true" />
          <span className="kavla-control-label">Settings</span>
        </TldrawUiButton>
      </TldrawUiDropdownMenuTrigger>
      <TldrawUiDropdownMenuContent
        className="kavla-settings-menu"
        side="right"
        align="start"
        sideOffset={6}
        alignOffset={0}
      >
        <TldrawUiMenuContextProvider type="menu" sourceId="main-menu">
          <TldrawUiMenuGroup id="basic">
            <EditSubmenu />
            <ViewSubmenu />
            <TldrawUiMenuActionItem actionId="insert-media" />
            <KeyboardShortcutsMenuItem />
          </TldrawUiMenuGroup>
          <TldrawUiMenuGroup id="settings">
            <JustIconsMenuItem />
            <TldrawUiMenuActionItem actionId="layout-kavla-nodes" disabled={layoutDisabled} />
            <TldrawUiMenuActionItem actionId="fit-query-nodes" disabled={layoutDisabled} />
            <ToggleDebugModeItem />
          </TldrawUiMenuGroup>
        </TldrawUiMenuContextProvider>
      </TldrawUiDropdownMenuContent>
    </TldrawUiDropdownMenuRoot>
  );
}
