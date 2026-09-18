import { FileText } from "lucide-react";

const SUMMARY_HEADER_COLOR = "#ccfbf1";
const SUMMARY_ACCENT_COLOR = "#14b8a6";

interface SummaryHeaderProps {
  name: string;
}

export function SummaryHeader({ name }: SummaryHeaderProps) {
  return (
    <div
      style={{
        height: 44,
        borderBottom: "4px solid #000",
        backgroundColor: SUMMARY_HEADER_COLOR,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 12px",
        flexShrink: 0,
      }}
    >
      <FileText size={16} strokeWidth={3} color={SUMMARY_ACCENT_COLOR} />
      <span
        title={name}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#111827",
          fontSize: 13,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {name}
      </span>
    </div>
  );
}
