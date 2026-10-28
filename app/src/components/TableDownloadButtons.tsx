import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { createPortal } from "react-dom";
import type { TableDownloadFormat } from "../../util/downloadTable";
import "./table-download-menu.css";

interface TableDownloadButtonsProps {
  buttonClassName: string;
  disabled?: boolean;
  disabledTitle?: string;
  onDownload: (format: TableDownloadFormat) => Promise<void>;
}

export function TableDownloadButtons({
  buttonClassName,
  disabled = false,
  disabledTitle = "Result data is not available locally",
  onDownload,
}: TableDownloadButtonsProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const isDownloadingRef = useRef(false);
  const resetTimeoutRef = useRef<number | null>(null);
  const [downloadingFormat, setDownloadingFormat] = useState<TableDownloadFormat | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  const startDownload = async (format: TableDownloadFormat) => {
    if (disabled || isDownloadingRef.current) {
      return;
    }

    isDownloadingRef.current = true;
    setIsMenuOpen(false);
    setDownloadingFormat(format);

    try {
      await onDownload(format);
    } finally {
      resetTimeoutRef.current = window.setTimeout(() => {
        isDownloadingRef.current = false;
        setDownloadingFormat(null);
        resetTimeoutRef.current = null;
      }, 1000);
    }
  };

  const isDownloading = downloadingFormat !== null;
  const isDisabled = disabled || isDownloading;

  const openMenu = () => {
    if (isDisabled || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPosition({ top: rect.top + rect.height / 2, left: rect.right });
    setIsMenuOpen(true);
  };

  const popupToRender =
    isMenuOpen && !isDisabled
      ? createPortal(
          <div
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              transform: "translateY(-50%)",
              paddingLeft: 8, // Invisible bridge to the button, matching ChartExportMenu.
              zIndex: 9999999,
              display: "flex",
              flexDirection: "column",
              pointerEvents: "all",
            }}
            onMouseEnter={() => setIsMenuOpen(true)}
            onMouseLeave={() => setIsMenuOpen(false)}
          >
            <div className="kavla-table-download-menu">
              {(["parquet", "csv"] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (event.pointerType === "touch") void startDownload(format);
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    void startDownload(format);
                  }}
                >
                  {format === "csv" ? "CSV" : "Parquet"}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <div
      style={{ position: "relative", pointerEvents: "all", width: "100%" }}
      onMouseEnter={openMenu}
      onMouseLeave={() => setIsMenuOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setIsMenuOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={isMenuOpen && !isDisabled}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch") openMenu();
        }}
        onClick={(event) => {
          event.stopPropagation();
          openMenu();
        }}
        disabled={isDisabled}
        title={disabled ? disabledTitle : isDownloading ? "Downloading" : "Download"}
        className={buttonClassName}
        style={{
          width: "100%",
          minWidth: isDownloading ? 84 : undefined,
          justifyContent: "center",
          touchAction: "none",
          backgroundColor: "#fff",
          padding: "0 4px",
          opacity: isDisabled ? 0.5 : 1,
          cursor: isDisabled ? "not-allowed" : "pointer",
        }}
      >
        {isDownloading ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <Download size={14} aria-hidden="true" />
        )}
        <span className="kavla-control-label" style={{ fontSize: 10 }}>
          {isDownloading ? "Downloading" : "Download"}
        </span>
      </button>
      {popupToRender}
    </div>
  );
}
