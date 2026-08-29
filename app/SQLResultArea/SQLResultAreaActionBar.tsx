import { Check, Copy } from "lucide-react";
import { TableDownloadButtons } from "@/components/TableDownloadButtons";
import type { TableDownloadFormat } from "../util/downloadTable";
import { SQL_RESULT_BUTTON_CLASS } from "./sql-result-area-styles";

interface SQLResultAreaActionBarProps {
  isCopied: boolean;
  isDisabled: boolean;
  onCopy: () => void;
  onDownload: (format: TableDownloadFormat) => Promise<void>;
}

export function SQLResultAreaActionBar({ isCopied, isDisabled, onCopy, onDownload }: SQLResultAreaActionBarProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        padding: 8,
        backgroundColor: "#f3f4f6",
        gap: 8,
        minWidth: 100,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
        <button
          onClick={onCopy}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (!isDisabled && event.pointerType === "touch") onCopy();
          }}
          disabled={isDisabled}
          title={isDisabled ? "Result data is not available locally" : "Copy to Clipboard (TSV)"}
          className={SQL_RESULT_BUTTON_CLASS}
          style={{
            width: "100%",
            justifyContent: "center",
            touchAction: "none",
            backgroundColor: "#fff",
            padding: "0 4px",
            opacity: isDisabled ? 0.5 : 1,
            cursor: isDisabled ? "not-allowed" : "pointer",
          }}
        >
          {isCopied ? <Check size={14} /> : <Copy size={14} />}
          <span style={{ fontSize: 10 }}>{isCopied ? "COPIED!" : "COPY"}</span>
        </button>

        <TableDownloadButtons buttonClassName={SQL_RESULT_BUTTON_CLASS} disabled={isDisabled} onDownload={onDownload} />
      </div>
    </div>
  );
}
