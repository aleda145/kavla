interface SQLResultAreaHeaderProps {
  resultName: string;
}

export function SQLResultAreaHeader({ resultName }: SQLResultAreaHeaderProps) {
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
        flexShrink: 0, // Header shouldn't shrink
      }}
    >
      <span>
        <span style={{ fontSize: 15 }}>{resultName}</span>
      </span>
    </div>
  );
}
