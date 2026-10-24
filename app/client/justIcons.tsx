import { useSyncExternalStore } from "react";
import { TldrawUiDropdownMenuCheckboxItem } from "tldraw";
import "./just-icons.css";

const STORAGE_KEY = "kavla.just-icons";
let justIcons = false;
let savedJustIcons = false;
let isMobile = false;
const listeners = new Set<() => void>();

function updateJustIcons(value: boolean) {
  savedJustIcons = value;
  justIcons = isMobile || value;
  document.documentElement.toggleAttribute("data-kavla-just-icons", justIcons);
  listeners.forEach((listener) => listener());
}

export function initializeJustIcons() {
  const mobileQuery = window.matchMedia("(max-width: 840px)");
  isMobile = mobileQuery.matches;
  updateJustIcons(localStorage.getItem(STORAGE_KEY) === "true");
  mobileQuery.addEventListener("change", (event) => {
    isMobile = event.matches;
    updateJustIcons(savedJustIcons);
  });
  window.addEventListener("storage", (event) => {
    if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) {
      updateJustIcons(localStorage.getItem(STORAGE_KEY) === "true");
    }
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function JustIconsMenuItem() {
  const checked = useSyncExternalStore(subscribe, () => justIcons);
  const mobile = useSyncExternalStore(subscribe, () => isMobile);
  return (
    <TldrawUiDropdownMenuCheckboxItem
      checked={checked}
      disabled={mobile}
      title={mobile ? "Always on for mobile" : "Just icons"}
      onSelect={() => {
        if (isMobile) return;
        const value = !justIcons;
        localStorage.setItem(STORAGE_KEY, String(value));
        updateJustIcons(value);
      }}
    >
      <span className="tlui-button__label">Just icons</span>
    </TldrawUiDropdownMenuCheckboxItem>
  );
}
