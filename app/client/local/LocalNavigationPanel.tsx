import { useState } from "react";
import { DefaultNavigationPanel, PORTRAIT_BREAKPOINT, useBreakpoint } from "tldraw";
import { LocalAssetsDialog } from "./LocalAssetsDialog";
import "./local-navigation-panel.css";

function formatCompactFileSize(fileSize: number): string {
  const megabytes = fileSize / (1024 * 1024);
  if (megabytes === 0) return "0 MB";
  if (megabytes < 0.1) return "<0.1 MB";
  if (megabytes < 999.5) {
    return `${Number(megabytes.toPrecision(3))} MB`;
  }
  return `${Number((megabytes / 1024).toPrecision(3))} GB`;
}

export function LocalNavigationPanel({ fileSize }: { fileSize: number | null }) {
  const breakpoint = useBreakpoint();
  const [assetsOpen, setAssetsOpen] = useState(false);

  return (
    <>
      {breakpoint >= PORTRAIT_BREAKPOINT.MOBILE && (
        <div className="kavla-navigation-panel">
          {fileSize !== null && (
            <button
              type="button"
              aria-label={`View canvas assets. Saved Kavla file size: ${formatCompactFileSize(fileSize)}`}
              aria-haspopup="dialog"
              aria-expanded={assetsOpen}
              onClick={() => setAssetsOpen(true)}
              className="kavla-navigation-file-size pointer-events-auto h-6 cursor-pointer select-none bg-white px-2 text-black hover:bg-slate-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black"
              style={{ fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: 850 }}
              title="Saved canvas size · View and manage assets"
            >
              {formatCompactFileSize(fileSize)}
            </button>
          )}
          <DefaultNavigationPanel />
        </div>
      )}
      {assetsOpen && <LocalAssetsDialog onClose={() => setAssetsOpen(false)} />}
    </>
  );
}
