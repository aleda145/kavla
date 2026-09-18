import { Code2, Eye, Search } from "lucide-react";
import type { ReactNode } from "react";
import type { LensViewMode } from "./lens-view-mode";

interface LensModeBarProps {
  viewMode: LensViewMode;
  onShowCode: () => void;
  onShowLens: () => void;
  onShowSql: () => void;
}

function LensModeButton({
  children,
  isActive,
  title,
  onClick,
}: {
  children: ReactNode;
  isActive: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.pointerType === "touch") {
          onClick();
        }
      }}
      title={title}
      style={{
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "2px solid black",
        background: isActive ? "#dbeafe" : "transparent",
        borderRadius: 4,
        cursor: "pointer",
        color: "#000",
      }}
    >
      {children}
    </button>
  );
}

export function LensModeBar({ viewMode, onShowCode, onShowLens, onShowSql }: LensModeBarProps) {
  return (
    <div
      style={{
        width: 48,
        borderLeft: "4px solid #000",
        backgroundColor: "#f3f4f6",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "12px 0",
        gap: 8,
        flexShrink: 0,
      }}
    >
      <LensModeButton isActive={viewMode === "lens"} title="Show Lens" onClick={onShowLens}>
        <Eye size={20} />
      </LensModeButton>
      <LensModeButton isActive={viewMode === "code"} title="Show Lens TSX" onClick={onShowCode}>
        <Code2 size={20} />
      </LensModeButton>
      <LensModeButton isActive={viewMode === "sql"} title="Show Lens data SQL" onClick={onShowSql}>
        <Search size={19} />
      </LensModeButton>
    </div>
  );
}
