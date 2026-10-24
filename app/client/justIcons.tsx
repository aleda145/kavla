import { useSyncExternalStore } from "react";
import "./just-icons.css";

const STORAGE_KEY = "kavla.just-icons";
let justIcons = false;
const listeners = new Set<() => void>();

function updateJustIcons(value: boolean) {
  justIcons = value;
  document.documentElement.toggleAttribute("data-kavla-just-icons", value);
  listeners.forEach((listener) => listener());
}

export function initializeJustIcons() {
  updateJustIcons(localStorage.getItem(STORAGE_KEY) === "true");
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

export function JustIconsToggle() {
  const checked = useSyncExternalStore(subscribe, () => justIcons);
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 text-sm font-bold">
      Just icons
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => {
          const value = event.currentTarget.checked;
          localStorage.setItem(STORAGE_KEY, String(value));
          updateJustIcons(value);
        }}
        className="relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-black bg-white transition-colors checked:bg-black after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-black after:transition-transform checked:after:translate-x-4 checked:after:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
      />
    </label>
  );
}
