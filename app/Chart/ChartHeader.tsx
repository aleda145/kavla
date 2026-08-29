interface ChartHeaderProps {
  sourceName: string;
}

export function ChartHeader({ sourceName }: ChartHeaderProps) {
  return (
    <div
      style={{
        height: 40,
        fontWeight: 800,
        borderBottom: "4px solid #000",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "#fce7f3", // Pink-100
        padding: "0 12px",
        fontSize: 14,
        flexShrink: 0,
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
      }}
    >
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sourceName}</span>
    </div>
  );
}
