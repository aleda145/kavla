import { ChartSelect } from "./ChartSelect";

interface ChartFooterProps {
  color: string | null;
  columns: string[];
  columnTypes: Record<string, string>;
  hasSource: boolean;
  x: string | null;
  y: string | null;
  onColorChange: (column: string | null) => void;
  onXChange: (column: string) => void;
  onYChange: (column: string) => void;
}

export function ChartFooter({
  color,
  columns,
  columnTypes,
  hasSource,
  x,
  y,
  onColorChange,
  onXChange,
  onYChange,
}: ChartFooterProps) {
  return (
    <div
      style={{
        height: 64,
        borderTop: "4px solid #000",
        backgroundColor: "#f9fafb",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 12,
        flexShrink: 0,
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
      }}
    >
      <ChartSelect
        title="X-Axis"
        value={x}
        options={columns}
        optionTypes={columnTypes}
        onSelect={onXChange}
        placeholder={hasSource ? "Select..." : "No source"}
        disabled={!hasSource}
      />
      <ChartSelect
        title="Y-Axis"
        value={y}
        options={columns}
        optionTypes={columnTypes}
        onSelect={onYChange}
        placeholder={hasSource ? "Select..." : "No source"}
        disabled={!hasSource}
      />
      <ChartSelect
        title="Color"
        value={color}
        options={["None", ...columns]}
        optionTypes={columnTypes}
        onSelect={(value) => onColorChange(value === "None" ? null : value)}
        placeholder={hasSource ? "Select..." : "No source"}
        disabled={!hasSource}
      />
    </div>
  );
}
