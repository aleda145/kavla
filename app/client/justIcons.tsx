import { useSyncExternalStore } from "react";
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

export function JustIconsToggle() {
  const checked = useSyncExternalStore(subscribe, () => justIcons);
  const mobile = useSyncExternalStore(subscribe, () => isMobile);
  return (
    <label
      className={`flex items-center justify-between gap-4 text-sm font-bold ${mobile ? "cursor-default" : "cursor-pointer"}`}
      title={mobile ? "Always on for mobile" : undefined}
    >
      Just icons
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={mobile}
        onChange={(event) => {
          if (isMobile) return;
          const value = event.currentTarget.checked;
          localStorage.setItem(STORAGE_KEY, String(value));
          updateJustIcons(value);
        }}
        className="relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full border-2 border-black bg-white transition-colors checked:bg-black after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-black after:transition-transform checked:after:translate-x-4 checked:after:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:cursor-default disabled:opacity-60"
      />
    </label>
  );
}
