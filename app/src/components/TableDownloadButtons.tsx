import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { TableDownloadFormat } from "../../util/downloadTable";

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

  const renderButton = (format: TableDownloadFormat) => {
    const isCurrentDownload = downloadingFormat === format;
    const isDisabled = disabled || downloadingFormat !== null;
    const label = format === "csv" ? "CSV" : "PARQUET";

    return (
      <button
        onClick={() => void startDownload(format)}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (!disabled && event.pointerType === "touch") {
            void startDownload(format);
          }
        }}
        disabled={isDisabled}
        title={disabled ? disabledTitle : `Download ${format === "csv" ? "CSV" : "Parquet"}`}
        className={buttonClassName}
        style={{
          width: "100%",
          minWidth: isCurrentDownload ? 84 : undefined,
          justifyContent: "center",
          touchAction: "none",
          backgroundColor: "#fff",
          padding: "0 4px",
          opacity: isDisabled ? 0.5 : 1,
          cursor: isDisabled ? "not-allowed" : "pointer",
        }}
      >
        {isCurrentDownload ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        <span style={{ fontSize: 10 }}>{isCurrentDownload ? "DOWNLOADING" : label}</span>
      </button>
    );
  };

  return (
    <>
      {renderButton("parquet")}
      {renderButton("csv")}
    </>
  );
}
