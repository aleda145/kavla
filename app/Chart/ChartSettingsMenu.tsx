import React, { useState, useRef, useEffect } from "react";
import { Settings, X } from "lucide-react";
import { createPortal } from "react-dom";

interface ChartSettingsMenuProps {
  chartType: string;
  yAxisScale: string;
  onYAxisScaleChange: (value: string) => void;
  isStacked: boolean;
  onIsStackedChange: (value: boolean) => void;
  limit: number | null;
  onLimitChange: (value: number | null) => void;
}

export const ChartSettingsMenu: React.FC<ChartSettingsMenuProps> = ({
  chartType,
  yAxisScale,
  onYAxisScaleChange,
  isStacked,
  onIsStackedChange,
  limit,
  onLimitChange,
}) => {
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, height: 0 });

  useEffect(() => {
    if (showSettingsMenu && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    }
  }, [showSettingsMenu]);

  // If clicked, it stays open until closed or clicked again.
  const handleMouseEnter = () => {
    if (!isPinned) setShowSettingsMenu(true);
  };

  const handleMouseLeave = () => {
    if (!isPinned) setShowSettingsMenu(false);
  };

  const handleTogglePin = (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    if (isPinned) {
      setIsPinned(false);
      setShowSettingsMenu(false);
    } else {
      setIsPinned(true);
      setShowSettingsMenu(true);
    }
  };

  const popupToRender = showSettingsMenu
    ? createPortal(
        <div
          style={{
            position: "fixed",
            top: position.top + position.height / 2, // center vertically with button
            left: position.left + position.width, // padding provides the 8px offset
            transform: "translateY(-50%)",
            zIndex: 9999999,
            display: "flex",
            flexDirection: "column",
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div
            style={{
              paddingLeft: 8, // Invisible bridge back to the button
            }}
          >
            <div
              style={{
                backgroundColor: "white",
                border: "2px solid #000",
                borderRadius: 4,
                boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                minWidth: 160,
                padding: "8px 12px",
                pointerEvents: "all",
                position: "relative",
              }}
            >
              {isPinned && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsPinned(false);
                    setShowSettingsMenu(false);
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.pointerType === "touch") {
                      setIsPinned(false);
                      setShowSettingsMenu(false);
                    }
                  }}
                  style={{
                    position: "absolute",
                    top: 6,
                    right: 6,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "#9ca3af", // Gray-400
                    padding: 2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#f3f4f6")}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  title="Close Settings"
                >
                  <X size={14} />
                </button>
              )}

              <div style={{ fontSize: 12, fontWeight: "bold", marginBottom: 8, color: "#444", paddingRight: 16 }}>
                CHART SETTINGS
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 10, fontWeight: "bold", textTransform: "uppercase" }}>Y-Axis Scale</label>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onYAxisScaleChange("auto");
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.pointerType === "touch") onYAxisScaleChange("auto");
                    }}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      background: yAxisScale === "auto" ? "#dbeafe" : "white",
                      border: yAxisScale === "auto" ? "2px solid #000" : "1px solid #ccc",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: "bold",
                      fontSize: 12,
                      color: "black",
                    }}
                  >
                    Auto
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onYAxisScaleChange("zero");
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.pointerType === "touch") onYAxisScaleChange("zero");
                    }}
                    style={{
                      flex: 1,
                      padding: "4px 8px",
                      background: yAxisScale === "zero" ? "#dbeafe" : "white",
                      border: yAxisScale === "zero" ? "2px solid #000" : "1px solid #ccc",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: "bold",
                      fontSize: 12,
                      color: "black",
                    }}
                  >
                    Zero
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                <label style={{ fontSize: 10, fontWeight: "bold", textTransform: "uppercase" }}>Limit</label>
                <div style={{ display: "flex", gap: 4 }}>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    value={limit ?? ""}
                    placeholder="10000"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      if (!value) {
                        onLimitChange(null);
                        return;
                      }

                      const numericValue = Number(value);
                      if (!Number.isFinite(numericValue)) {
                        return;
                      }

                      onLimitChange(Math.max(1, Math.min(10000, Math.round(numericValue))));
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: "4px 8px",
                      border: "1px solid #ccc",
                      borderRadius: 4,
                      fontWeight: "bold",
                      fontSize: 12,
                      color: "black",
                    }}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onLimitChange(null);
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (e.pointerType === "touch") onLimitChange(null);
                    }}
                    style={{
                      padding: "4px 8px",
                      background: limit === null ? "#dbeafe" : "white",
                      border: limit === null ? "2px solid #000" : "1px solid #ccc",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontWeight: "bold",
                      fontSize: 12,
                      color: "black",
                    }}
                  >
                    Default
                  </button>
                </div>
              </div>

              {(chartType === "bar" || chartType === "area") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 12 }}>
                  <label style={{ fontSize: 10, fontWeight: "bold", textTransform: "uppercase" }}>Layout</label>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onIsStackedChange(false);
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.pointerType === "touch") onIsStackedChange(false);
                      }}
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        background: !isStacked ? "#dbeafe" : "white",
                        border: !isStacked ? "2px solid #000" : "1px solid #ccc",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontWeight: "bold",
                        fontSize: 12,
                        color: "black",
                      }}
                    >
                      Grouped
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onIsStackedChange(true);
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        if (e.pointerType === "touch") onIsStackedChange(true);
                      }}
                      style={{
                        flex: 1,
                        padding: "4px 8px",
                        background: isStacked ? "#dbeafe" : "white",
                        border: isStacked ? "2px solid #000" : "1px solid #ccc",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontWeight: "bold",
                        fontSize: 12,
                        color: "black",
                      }}
                    >
                      Stacked
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div
      style={{ position: "relative", pointerEvents: "all" }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        ref={buttonRef}
        title="Settings"
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.pointerType === "touch") handleTogglePin(e);
        }}
        onClick={handleTogglePin}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid #000",
          background: showSettingsMenu || isPinned ? "#f3f4f6" : "#fff",
          borderRadius: 4,
          cursor: "pointer",
          color: "#000",
          boxShadow: showSettingsMenu || isPinned ? "2px 2px 0px 0px rgba(0,0,0,1)" : "none",
          transition: "all 0.15s ease",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.boxShadow = "2px 2px 0px 0px rgba(0,0,0,1)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.boxShadow = showSettingsMenu || isPinned ? "2px 2px 0px 0px rgba(0,0,0,1)" : "none";
        }}
        onMouseDown={(e) => {
          e.currentTarget.style.transform = "translate(1px, 1px)";
          e.currentTarget.style.boxShadow = "1px 1px 0px 0px rgba(0,0,0,1)";
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = "none";
          e.currentTarget.style.boxShadow = "2px 2px 0px 0px rgba(0,0,0,1)";
        }}
      >
        <Settings size={20} />
      </button>

      {popupToRender}
    </div>
  );
};
