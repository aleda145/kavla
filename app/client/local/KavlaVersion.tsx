import { useEditor, useValue } from "tldraw";
import { useKavlaVersion } from "../localServer/runtimeStore";

export function KavlaVersionBadge() {
  const info = useKavlaVersion();
  const editor = useEditor();
  const bottom = useValue(
    "version label position",
    () => {
      const watermarkBottom = editor.getInstanceState().isDebugMode ? 46 : 8;
      const watermarkHeight = editor.getViewportScreenBounds().width < 700 ? 52 : 36;
      return watermarkBottom + watermarkHeight + 4;
    },
    [editor]
  );
  if (!info?.currentVersion) return null;
  const version = /^\d/.test(info.currentVersion) ? `v${info.currentVersion}` : info.currentVersion;
  const mockUpdate =
    (import.meta.env.DEV || info.currentVersion === "dev") &&
    new URLSearchParams(window.location.search).get("mockUpdate") === "1";
  const updateAvailable = mockUpdate || info.status === "update";

  return (
    <a
      href={updateAvailable ? "https://kavla.dev/download" : "https://kavla.dev"}
      target="_blank"
      rel="noopener noreferrer"
      data-allow-middle-click
      title={updateAvailable ? "new version available" : undefined}
      aria-label={`Kavla ${version}${updateAvailable ? ": new version available" : ": visit kavla.dev"}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="pointer-events-auto absolute right-3 flex cursor-pointer select-none items-center gap-1 text-[11px] no-underline opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      style={{ bottom, color: "var(--color-text)", zIndex: "var(--layer-watermark)" }}
    >
      {updateAvailable && (
        <span aria-hidden="true" className="text-lg font-bold text-red-600">
          !
        </span>
      )}
      <img src="/kavla.svg" alt="" draggable={false} className="h-3.5 w-3.5" />
      <span>Kavla {version}</span>
    </a>
  );
}
