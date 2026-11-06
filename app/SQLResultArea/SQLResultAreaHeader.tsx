import type { ReactNode } from "react";

interface SQLResultAreaHeaderProps {
  resultName: string;
  children?: ReactNode;
}

export function SQLResultAreaHeader({ resultName, children }: SQLResultAreaHeaderProps) {
  return (
    <div
      style={{
        padding: "8px 12px",
        fontWeight: 800,
        borderBottom: "4px solid #000",
        backgroundColor: "#dcfce7", // Green-100 (Always)
        fontSize: 14,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        flexShrink: 0, // Header shouldn't shrink
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 15 }}>{resultName}</span>
      </span>
      {children}
    </div>
  );
}
