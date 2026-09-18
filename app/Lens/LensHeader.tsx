import { Info, RefreshCw } from "lucide-react";

interface LensHeaderProps {
  description: string | null;
  hasRetryStatus: boolean;
  title: string;
}

export function LensHeader({ description, hasRetryStatus, title }: LensHeaderProps) {
  return (
    <div
      style={{
        height: 42,
        flexShrink: 0,
        borderBottom: "4px solid #000",
        background: "#fce7f3",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "0 12px",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {description && (
          <span
            aria-label="Lens info"
            title={description}
            style={{
              fontSize: 10,
              backgroundColor: "#fff",
              color: "#000",
              width: 22,
              height: 22,
              borderRadius: 4,
              border: "2px solid #000",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              cursor: "help",
              fontWeight: "bold",
              boxShadow: "2px 2px 0px 0px rgba(0,0,0,1)",
            }}
          >
            <Info size={12} color="#111827" />
          </span>
        )}
        {hasRetryStatus && (
          <RefreshCw size={16} color="#991b1b" aria-label="Lens retry status" style={{ flexShrink: 0 }} />
        )}
      </div>
    </div>
  );
}
