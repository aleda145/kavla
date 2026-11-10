import { Settings } from "lucide-react";
import {
  EditSubmenu,
  KeyboardShortcutsMenuItem,
  TldrawUiButton,
  TldrawUiDropdownMenuCheckboxItem,
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
import { autoPlacement, toggleAutoPlacement } from "./canvas/autoPlacement";

export function CanvasSettingsMenu() {
  const editor = useEditor();
  const autoPlacing = useValue("Auto placement", () => autoPlacement.get(), []);
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
            <TldrawUiDropdownMenuCheckboxItem
              checked={autoPlacing}
              onSelect={toggleAutoPlacement}
              title="Place new nodes automatically without moving existing nodes"
            >
              <span className="tlui-button__label">Auto placement</span>
            </TldrawUiDropdownMenuCheckboxItem>
            <TldrawUiMenuActionItem actionId="layout-kavla-nodes" disabled={layoutDisabled} />
            <TldrawUiMenuActionItem actionId="fit-query-nodes" disabled={layoutDisabled} />
            <ToggleDebugModeItem />
          </TldrawUiMenuGroup>
        </TldrawUiMenuContextProvider>
      </TldrawUiDropdownMenuContent>
    </TldrawUiDropdownMenuRoot>
  );
}
