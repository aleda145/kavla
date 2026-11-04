import React from "react";
import { Database, File, Folder, Loader2, Search, Upload, X } from "lucide-react";
import { siDuckdb, siGooglebigquery, siPostgresql } from "simple-icons";
import type { CliSource } from "../client/useLocalServer";
import { TldrawScrollAreaIndicator } from "./TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "./useTldrawScrollArea";

const buttonBaseClass =
  "h-9 px-3 border-2 border-black text-black font-bold text-[10px] flex items-center justify-center gap-2 rounded cursor-pointer shadow-[2px_2px_0px_0px_rgba(0,0,0,0.2)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px]";

const SOURCE_PICKER_COLUMNS = 2;
const SOURCE_CARD_HEIGHT = 46;
const SOURCE_ROW_GAP = 12;
const SOURCE_PICKER_CHROME_HEIGHT = 72;
export const DATA_SOURCE_PICKER_WIDTH = 380;

export function calculateDataSourcePickerHeight(sources: readonly CliSource[]): number {
  const sourceCount = sources.filter((source) => source.name !== "uploaded_files").length;
  const sourceRowCount = Math.ceil((sourceCount + 1) / SOURCE_PICKER_COLUMNS);
  const fileRowCount = sources.some((source) => source.name === "uploaded_files") ? 2 : 1;
  const cardsHeight = (fileRowCount + sourceRowCount) * SOURCE_CARD_HEIGHT;
  const gapsHeight = (fileRowCount - 1 + sourceRowCount - 1) * SOURCE_ROW_GAP;
  const dividerHeight = 34;
  return Math.max(300, SOURCE_PICKER_CHROME_HEIGHT + cardsHeight + gapsHeight + dividerHeight);
}

type DataSourcePickerProps = {
  sources: CliSource[];
  onFileClick: () => void;
  onDemoClick: () => void;
  onSourceClick: (sourceName: string) => void;
};

type CliSourceAppearance = {
  backgroundColor: string;
  hoverClassName: string;
  iconSvg: string | null;
  IconComponent: typeof Database;
};

const CLI_SOURCE_APPEARANCE: Record<string, { backgroundColor: string; hoverClassName: string }> = {
  bigquery: { backgroundColor: "#dbeafe", hoverClassName: "hover:bg-blue-200" },
  duckdb: { backgroundColor: "#fde68a", hoverClassName: "hover:bg-yellow-300" },
  directory: { backgroundColor: "#dcfce7", hoverClassName: "hover:bg-green-200" },
  postgres: { backgroundColor: "#c7d2fe", hoverClassName: "hover:bg-indigo-200" },
};

export function getCliSourceAppearance(source: { type: string; name?: string }): CliSourceAppearance {
  if (source.name === "uploaded_files") {
    return {
      backgroundColor: "#dbeafe",
      hoverClassName: "hover:bg-blue-200",
      iconSvg: null,
      IconComponent: File,
    };
  }

  let IconComponent = Database;
  let iconSvg: string | null = null;

  if (source.type === "duckdb") {
    iconSvg = siDuckdb.path;
  } else if (source.type === "bigquery") {
    iconSvg = siGooglebigquery.path;
  } else if (source.type === "postgres") {
    iconSvg = siPostgresql.path;
  } else if (source.type === "directory") {
    IconComponent = Folder;
  }

  return {
    backgroundColor: CLI_SOURCE_APPEARANCE[source.type]?.backgroundColor ?? "#f3f4f6",
    hoverClassName: CLI_SOURCE_APPEARANCE[source.type]?.hoverClassName ?? "hover:bg-gray-100",
    iconSvg,
    IconComponent,
  };
}

export function CliSourceIcon({
  source,
  size = 18,
}: {
  source: { type: string; name?: string; loading?: boolean };
  size?: number;
}) {
  const { IconComponent, iconSvg } = getCliSourceAppearance(source);
  if (source.loading) {
    return <Loader2 aria-hidden="true" size={size} className="animate-spin shrink-0" />;
  }
  if (iconSvg) {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: size, height: size, fill: "#000", flexShrink: 0, overflow: "visible" }}
      >
        <path d={iconSvg} />
      </svg>
    );
  }
  return <IconComponent aria-hidden="true" size={size} />;
}

export const DataSourcePicker: React.FC<DataSourcePickerProps> = ({
  sources,
  onFileClick,
  onDemoClick,
  onSourceClick,
}) => {
  const scrollArea = useTldrawScrollArea();
  const uploadedSources = sources.filter((source) => source.name === "uploaded_files");
  const sortedSources = sources
    .filter((source) => source.name !== "uploaded_files")
    .sort((a, b) => a.name.localeCompare(b.name));

  const openSources = () => window.dispatchEvent(new Event("kavla:open-sources"));

  const renderSourceButton = (src: CliSource) => {
    const { backgroundColor, hoverClassName } = getCliSourceAppearance(src);
    const label = src.name === "uploaded_files" ? "Browse files" : src.name;
    const hasError = !src.loading && src.available === false && Boolean(src.error);
    const isDisconnected = !src.loading && src.available === false && !src.error;
    const title = src.loading
      ? `${label} · Connecting…`
      : hasError
        ? `${label}\n${src.error}`
        : isDisconnected
          ? `Connect to ${label} and browse tables`
          : label;

    return (
      <button
        key={src.name}
        className={`${buttonBaseClass} ${hoverClassName}`}
        style={{
          touchAction: "none",
          boxSizing: "border-box",
          flex: "1 1 132px",
          minWidth: 0,
          maxWidth: "160px",
          width: "100%",
          height: 46,
          padding: "8px 12px",
          justifyContent: "center",
          backgroundColor,
          position: "relative",
          outline: hasError ? "2px solid #ef4444" : undefined,
        }}
        onClick={() => onSourceClick(src.name)}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.pointerType === "touch") onSourceClick(src.name);
        }}
        title={title}
        aria-label={title}
        aria-busy={src.loading === true}
      >
        {hasError && (
          <span
            title={src.error ?? "Source unavailable"}
            style={{
              position: "absolute",
              top: -7,
              right: -7,
              width: 18,
              height: 18,
              borderRadius: 999,
              border: "2px solid black",
              background: "#ef4444",
              color: "white",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "2px 2px 0px 0px rgba(0,0,0,0.9)",
            }}
          >
            <X size={10} strokeWidth={3} />
          </span>
        )}
        <CliSourceIcon source={src} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
          {src.loading && <span className="block text-[9px] font-normal">Connecting…</span>}
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="w-full min-h-0 flex flex-col gap-3" style={{ flex: "1 1 0" }}>
        <div
          ref={scrollArea.ref}
          onPointerDown={scrollArea.onPointerDown}
          onPointerMove={scrollArea.onPointerMove}
          onPointerUp={scrollArea.onPointerUp}
          onPointerCancel={scrollArea.onPointerCancel}
          onWheel={scrollArea.onWheel}
          style={{
            boxSizing: "border-box",
            flex: "1 1 0",
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "16px 10px 8px 8px",
            pointerEvents: "auto",
          }}
        >
          <div
            role="group"
            aria-label="Files"
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 12,
              width: "100%",
            }}
          >
            <button
              className={`${buttonBaseClass} hover:bg-green-300`}
              style={{
                touchAction: "none",
                boxSizing: "border-box",
                flex: "1 1 132px",
                minWidth: 0,
                maxWidth: "160px",
                width: "100%",
                height: 46,
                padding: "8px 12px",
                justifyContent: "center",
                backgroundColor: "#bbf7d0",
              }}
              onClick={onFileClick}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.pointerType === "touch") onFileClick();
              }}
              title="Upload a CSV, Parquet, JSON, or NDJSON file"
            >
              <Upload size={18} />
              <span className="kavla-control-label">Pick a file</span>
            </button>
            {uploadedSources.map(renderSourceButton)}
            <button
              type="button"
              className={`${buttonBaseClass} bg-white hover:bg-yellow-50`}
              style={{
                touchAction: "none",
                boxSizing: "border-box",
                flex: "1 1 132px",
                minWidth: 0,
                maxWidth: "160px",
                width: "100%",
                height: 46,
                padding: "8px 12px",
              }}
              title="Browse demo data"
              onClick={onDemoClick}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.pointerType === "touch") onDemoClick();
              }}
            >
              <Search aria-hidden="true" size={18} />
              <span className="kavla-control-label">Demo data</span>
            </button>
          </div>
          <div
            role="group"
            aria-label="Sources"
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 12,
              width: "100%",
              marginTop: 16,
              paddingTop: 16,
              borderTop: "2px solid #000",
            }}
          >
            {sortedSources.map(renderSourceButton)}
            <button
              type="button"
              className={`${buttonBaseClass} bg-blue-100 hover:bg-blue-200`}
              style={{
                touchAction: "none",
                boxSizing: "border-box",
                flex: "1 1 132px",
                minWidth: 0,
                maxWidth: "160px",
                width: "100%",
                height: 46,
                padding: "8px 12px",
              }}
              onClick={openSources}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (event.pointerType === "touch") openSources();
              }}
              title="Open source settings to connect a data source"
            >
              <Database aria-hidden="true" size={18} />
              <span className="kavla-control-label">Add a source</span>
            </button>
          </div>
        </div>
      </div>
      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />
    </>
  );
};
