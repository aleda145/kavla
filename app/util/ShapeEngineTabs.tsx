import React from "react";
import { createPortal } from "react-dom";
import { Database, FileJson, FileSpreadsheet, FileText, Folder, type LucideIcon } from "lucide-react";
import { siDuckdb, siGooglebigquery, siPostgresql } from "simple-icons";
import dbtLogo from "../Dbt/dbt-logo.svg";

export type ShapeEngineTab = {
  key: string;
  type: string | null | undefined;
  active: boolean;
  title: string;
  details?: string[];
  layerZIndex?: number;
  topOffset?: number;
  onClick?: () => void;
};

type EngineAppearance = {
  label: string;
  backgroundColor: string;
  iconSvg: string | null;
  IconComponent: LucideIcon;
};

export function getEngineAppearance(type: string | null | undefined): EngineAppearance {
  if (type === "dbt") {
    return { label: "dbt", backgroundColor: "#ffedd5", iconSvg: null, IconComponent: Database };
  }
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

  if (type === "dbt") return <img src={dbtLogo} alt="" aria-hidden="true" style={{ width: 20, height: 20 }} />;

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
  const [openTabPopover, setOpenTabPopover] = React.useState<{
    key: string;
    rect: DOMRect;
  } | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );
  const keepPopover = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const closePopover = () => {
    keepPopover();
    closeTimer.current = setTimeout(() => setOpenTabPopover(null), 150);
  };
  const openTab = tabs.find((tab) => tab.key === openTabPopover?.key);
  if (!tabs.length) return null;

  const openPopover = (
    event: React.MouseEvent<HTMLDivElement> | React.FocusEvent<HTMLDivElement>,
    tab: ShapeEngineTab
  ) => {
    keepPopover();
    setOpenTabPopover({
      key: tab.key,
      rect: event.currentTarget.getBoundingClientRect(),
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
                role={tab.onClick ? "button" : undefined}
                tabIndex={0}
                onPointerDown={tab.onClick ? (event) => event.stopPropagation() : undefined}
                onClick={
                  tab.onClick
                    ? () => {
                        setOpenTabPopover(null);
                        tab.onClick?.();
                      }
                    : undefined
                }
                onKeyDown={(event) => {
                  if (tab.onClick && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenTabPopover(null);
                    tab.onClick();
                  }
                }}
                onMouseEnter={(event) => openPopover(event, tab)}
                onMouseLeave={closePopover}
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
                  cursor: tab.onClick ? "pointer" : "help",
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
        openTab &&
        createPortal(
          <div
            onMouseEnter={keepPopover}
            onMouseLeave={closePopover}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              left: Math.max(
                openTab.type === "dbt" ? 190 : 150,
                Math.min(
                  window.innerWidth - (openTab.type === "dbt" ? 190 : 150),
                  openTabPopover.rect.left + openTabPopover.rect.width / 2
                )
              ),
              top: openTabPopover.rect.top < 340 ? openTabPopover.rect.bottom + 12 : openTabPopover.rect.top - 12,
              transform: openTabPopover.rect.top < 340 ? "translateX(-50%)" : "translate(-50%, -100%)",
              width: openTab.type === "dbt" ? 360 : 280,
              maxWidth: "calc(100vw - 24px)",
              overflowWrap: "anywhere",
              pointerEvents: "auto",
              zIndex: 999999,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                ...(openTabPopover.rect.top < 340 ? { top: -8 } : { bottom: -8 }),
                width: 14,
                height: 14,
                transform: `translateX(-50%) rotate(${openTabPopover.rect.top < 340 ? 225 : 45}deg)`,
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
                maxHeight:
                  openTabPopover.rect.top < 340
                    ? `calc(100vh - ${openTabPopover.rect.bottom + 36}px)`
                    : openTabPopover.rect.top - 36,
                overflowY: "auto",
                overscrollBehavior: "contain",
                boxShadow: "4px 4px 0px 0px rgba(0,0,0,1)",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 900,
                  textTransform: "uppercase",
                  letterSpacing: "0.6px",
                  marginBottom: openTab.details?.length ? 6 : 0,
                }}
              >
                {openTab.title}
              </div>
              {openTab.details?.map((detail) => (
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
