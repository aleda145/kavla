import type { ReactNode } from "react";

interface ChartHeaderProps {
  sourceName: string;
  children?: ReactNode;
}

export function ChartHeader({ sourceName, children }: ChartHeaderProps) {
  return (
    <div
      style={{
        height: 40,
        fontWeight: 800,
        borderBottom: "4px solid #000",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
        backgroundColor: "#fce7f3", // Pink-100
        padding: "0 12px",
        fontSize: 14,
        flexShrink: 0,
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
      }}
    >
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sourceName}</span>
      {children}
    </div>
  );
}
