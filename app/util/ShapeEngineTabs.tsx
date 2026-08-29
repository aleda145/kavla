import React from "react";
import { createPortal } from "react-dom";
import { Database, FileJson, FileSpreadsheet, FileText, Folder, type LucideIcon } from "lucide-react";
import { siDuckdb, siGooglebigquery, siPostgresql } from "simple-icons";

export type ShapeEngineTab = {
  key: string;
  type: string | null | undefined;
  active: boolean;
  title: string;
  details?: string[];
  layerZIndex?: number;
  topOffset?: number;
};

type EngineAppearance = {
  label: string;
  backgroundColor: string;
  iconSvg: string | null;
  IconComponent: LucideIcon;
};

export function getEngineAppearance(type: string | null | undefined): EngineAppearance {
  if (type === "duckdb") {
    return {
      label: "DuckDB",
      backgroundColor: "#fde68a",
      iconSvg: siDuckdb.path,
      IconComponent: Database,
    };
  }

  if (type === "bigquery") {
    return {
      label: "BigQuery",
      backgroundColor: "#dbeafe",
      iconSvg: siGooglebigquery.path,
      IconComponent: Database,
    };
  }

  if (type === "directory") {
    return {
      label: "Directory",
      backgroundColor: "#dcfce7",
      iconSvg: null,
      IconComponent: Folder,
    };
  }

  if (type === "postgres") {
    return {
      label: "Postgres",
      backgroundColor: "#c7d2fe",
      iconSvg: siPostgresql.path,
      IconComponent: Database,
    };
  }

  if (type === "csv") {
    return {
      label: "CSV",
      backgroundColor: "#dcfce7",
      iconSvg: null,
      IconComponent: FileSpreadsheet,
    };
  }

  if (type === "parquet") {
    return {
      label: "Parquet",
      backgroundColor: "#fef3c7",
      iconSvg: null,
      IconComponent: FileText,
    };
  }

  if (type === "json") {
    return {
      label: "JSON",
      backgroundColor: "#ede9fe",
      iconSvg: null,
      IconComponent: FileJson,
    };
  }

  return {
    label: "Remote",
    backgroundColor: "#e5e7eb",
    iconSvg: null,
    IconComponent: Database,
  };
}

function ShapeEngineTabIcon({ type }: { type: string | null | undefined }) {
  const appearance = getEngineAppearance(type);

  if (appearance.iconSvg) {
    return (
      <svg
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: 18, height: 18, fill: "#000", flexShrink: 0, overflow: "visible" }}
        aria-hidden="true"
      >
        <path d={appearance.iconSvg} />
      </svg>
    );
  }

  const IconComponent = appearance.IconComponent;
  return <IconComponent size={18} aria-hidden="true" />;
}

export function ShapeEngineTabs({ tabs, style }: { tabs: ShapeEngineTab[]; style?: React.CSSProperties }) {
  if (!tabs.length) {
    return null;
  }

  const [openTabPopover, setOpenTabPopover] = React.useState<{
    key: string;
    rect: DOMRect;
    title: string;
    details?: string[];
  } | null>(null);

  const openPopover = (
    event: React.MouseEvent<HTMLDivElement> | React.FocusEvent<HTMLDivElement>,
    tab: ShapeEngineTab
  ) => {
    setOpenTabPopover({
      key: tab.key,
      rect: event.currentTarget.getBoundingClientRect(),
      title: tab.title,
      details: tab.details,
    });
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          padding: "8px 12px 0 12px",
          marginBottom: "-2px",
          gap: 0,
          position: "relative",
          ...style,
        }}
      >
        {tabs.map((tab) => {
          const appearance = getEngineAppearance(tab.type);

          return (
            <div
              key={tab.key}
              style={{
                position: "relative",
                top: tab.topOffset ?? (tab.active ? 0 : 4),
                marginRight: "-2px",
                zIndex: tab.layerZIndex ?? (tab.active ? 3 : 1),
              }}
            >
              <div
                title={tab.title}
                aria-label={tab.title}
                tabIndex={0}
                onMouseEnter={(event) => openPopover(event, tab)}
                onMouseLeave={() => {
                  setOpenTabPopover((currentPopover) => (currentPopover?.key === tab.key ? null : currentPopover));
                }}
                onFocus={(event) => openPopover(event, tab)}
                onBlur={() => {
                  setOpenTabPopover((currentPopover) => (currentPopover?.key === tab.key ? null : currentPopover));
                }}
                style={{
                  width: 40,
                  height: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "2px solid #000",
                  borderBottomColor: tab.active ? appearance.backgroundColor : "#000",
                  borderTopLeftRadius: 10,
                  borderTopRightRadius: 10,
                  backgroundColor: appearance.backgroundColor,
                  paddingBottom: tab.active ? 3 : 0,
                  boxShadow: tab.active ? "none" : "2px 2px 0px 0px rgba(0,0,0,0.15)",
                  zIndex: tab.layerZIndex ?? (tab.active ? 3 : 1),
                  cursor: "help",
                  outline: "none",
                }}
              >
                <ShapeEngineTabIcon type={tab.type} />
              </div>
            </div>
          );
        })}
      </div>
      {openTabPopover &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: openTabPopover.rect.left + openTabPopover.rect.width / 2,
              top: openTabPopover.rect.top - 12,
              transform: "translate(-50%, -100%)",
              minWidth: 220,
              maxWidth: 280,
              pointerEvents: "none",
              zIndex: 999999,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                bottom: -8,
                width: 14,
                height: 14,
                transform: "translateX(-50%) rotate(45deg)",
                backgroundColor: "#fff",
                borderRight: "2px solid #000",
                borderBottom: "2px solid #000",
              }}
            />
            <div
              style={{
                backgroundColor: "#fff",
                border: "2px solid #000",
                borderRadius: 10,
                padding: "10px 12px",
                boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: "0.6px",
                  marginBottom: openTabPopover.details?.length ? 6 : 0,
                }}
              >
                {openTabPopover.title}
              </div>
              {openTabPopover.details?.map((detail) => (
                <div
                  key={detail}
                  style={{
                    fontSize: 11,
                    lineHeight: 1.35,
                    color: "#111",
                    fontWeight: 700,
                  }}
                >
                  {detail}
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
