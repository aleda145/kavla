import React, { useState, useRef, useEffect } from "react";
import ReactECharts from "echarts-for-react";
import { Download } from "lucide-react";
import { createPortal } from "react-dom";

interface ChartExportMenuProps {
  chartRef: React.RefObject<ReactECharts | null>;
  fileName: string;
}

export const ChartExportMenu: React.FC<ChartExportMenuProps> = ({ chartRef, fileName }) => {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, height: 0 });

  useEffect(() => {
    if (showExportMenu && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    }
  }, [showExportMenu]);

  const handleDownload = (format: "png" | "svg" = "png") => {
    if (chartRef.current) {
      const echartInstance = chartRef.current.getEchartsInstance();

      let dataUrl: string;
      try {
        dataUrl = echartInstance.getDataURL({
          type: format,
          pixelRatio: 4, // Increased for higher resolution PNGs
          backgroundColor: "#fff",
        });
      } catch (e) {
        console.error("Failed to get data URL", e);
        return;
      }

      const downloadFn = (url: string, extension: string) => {
        const link = document.createElement("a");
        link.download = `${fileName}.${extension}`;
        link.href = url;
        link.click();
      };

      if (format === "png" && dataUrl.startsWith("data:image/svg+xml")) {
        const img = new Image();
        img.onload = () => {
          const scale = 2; // Use true 2x pixel scaling instead of trusting dataUrl properties
          const canvas = document.createElement("canvas");
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.scale(scale, scale);
            ctx.drawImage(img, 0, 0, img.width, img.height);
            downloadFn(canvas.toDataURL("image/png"), "png");
          }
        };
        img.src = dataUrl;
      } else {
        downloadFn(dataUrl, format);
      }

      setShowExportMenu(false);
    }
  };

  const popupToRender = showExportMenu
    ? createPortal(
        <div
          style={{
            position: "fixed",
            top: position.top + position.height / 2,
            left: position.left + position.width,
            transform: "translateY(-50%)",
            paddingLeft: 8, // Invisible bridge to the button
            zIndex: 9999999,
            display: "flex",
            flexDirection: "column",
          }}
          onMouseEnter={() => setShowExportMenu(true)}
          onMouseLeave={() => setShowExportMenu(false)}
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
              minWidth: 100,
              pointerEvents: "all",
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownload("png");
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.pointerType === "touch") handleDownload("png");
              }}
              style={{
                padding: "8px 12px",
                background: "none",
                border: "none",
                borderBottom: "1px solid #000",
                textAlign: "left",
                cursor: "pointer",
                fontWeight: "bold",
                fontSize: 12,
                width: "100%",
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#f3f4f6")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              PNG
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownload("svg");
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.pointerType === "touch") handleDownload("svg");
              }}
              style={{
                padding: "8px 12px",
                background: "none",
                border: "none",
                textAlign: "left",
                cursor: "pointer",
                fontWeight: "bold",
                fontSize: 12,
                width: "100%",
              }}
              onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "#f3f4f6")}
              onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            >
              SVG
            </button>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div
      style={{ position: "relative", pointerEvents: "all" }}
      onMouseEnter={() => setShowExportMenu(true)}
      onMouseLeave={() => setShowExportMenu(false)}
    >
      <button
        ref={buttonRef}
        title="Download"
        onClick={() => handleDownload("png")}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.pointerType === "touch") handleDownload("png");
        }}
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid #000",
          background: showExportMenu ? "#f3f4f6" : "#fff",
          borderRadius: 4,
          cursor: "pointer",
          color: "#000",
          boxShadow: showExportMenu ? "2px 2px 0px 0px rgba(0,0,0,1)" : "none",
          transition: "all 0.15s ease",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.boxShadow = "2px 2px 0px 0px rgba(0,0,0,1)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.boxShadow = showExportMenu ? "2px 2px 0px 0px rgba(0,0,0,1)" : "none";
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
        <Download size={20} />
      </button>

      {popupToRender}
    </div>
  );
};
