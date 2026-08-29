import { useEffect, useState } from "react";
import { Check, Copy, Database } from "lucide-react";
import type { CliSource } from "../client/useLocalServer";
import { CliSourceIcon, getCliSourceAppearance } from "./CliSourcesList";
import { SourceListView } from "./SourceListView";

type RemoteTablesListProps = {
  isLoading: boolean;
  onBack: () => void;
  onTableSelect: (table: string) => void;
  selectedRemoteSource: string;
  remoteTables: string[] | null;
  sourceError: string | null;
  cliSources: CliSource[];
};

export function RemoteTablesList({
  isLoading,
  onBack,
  onTableSelect,
  selectedRemoteSource,
  remoteTables,
  sourceError,
  cliSources,
}: RemoteTablesListProps) {
  const [copiedError, setCopiedError] = useState(false);
  const selectedCliSource = cliSources.find((source) => source.name === selectedRemoteSource) ?? null;
  const selectedCliAppearance = selectedCliSource ? getCliSourceAppearance(selectedCliSource) : null;
  const remoteTableHoverClassName = selectedCliAppearance?.hoverClassName ?? "hover:bg-gray-100";
  const headerIcon = selectedCliSource ? (
    <CliSourceIcon source={selectedCliSource} size={14} />
  ) : (
    <Database size={14} />
  );

  useEffect(() => {
    if (!copiedError) return;

    const timeout = window.setTimeout(() => setCopiedError(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copiedError]);

  useEffect(() => {
    setCopiedError(false);
  }, [selectedRemoteSource, sourceError]);

  const handleCopyError = async () => {
    if (!sourceError) return;

    try {
      await navigator.clipboard.writeText(sourceError);
      setCopiedError(true);
    } catch {
      const textArea = document.createElement("textarea");
      textArea.value = sourceError;
      textArea.setAttribute("readonly", "");
      textArea.style.position = "absolute";
      textArea.style.left = "-9999px";
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopiedError(true);
    }
  };

  return (
    <SourceListView
      items={remoteTables ?? []}
      emptyState={
        sourceError ? (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              display: "flex",
              flex: 1,
              minHeight: "100%",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <div
              style={{
                width: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                background: "#fef2f2",
                border: "3px solid #000",
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              <div
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  width: "100%",
                  padding: "12px 12px 10px 12px",
                  background: "transparent",
                  color: "red",
                  fontFamily: "inherit",
                  fontSize: "12px",
                  whiteSpace: "pre-wrap",
                  boxSizing: "border-box",
                  fontWeight: "bold",
                  userSelect: "text",
                  wordBreak: "break-word",
                }}
                title={sourceError}
              >
                {sourceError}
              </div>
              <button
                type="button"
                onClick={handleCopyError}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  width: "100%",
                  border: "none",
                  borderTop: "3px solid #000",
                  background: copiedError ? "#dcfce7" : "#fff",
                  color: copiedError ? "#166534" : "red",
                  padding: "8px 10px",
                  fontSize: "11px",
                  fontWeight: 900,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                title="Copy error"
              >
                {copiedError ? <Check size={12} strokeWidth={3} /> : <Copy size={12} strokeWidth={2.5} />}
                <span>{copiedError ? "Copied" : "Copy error"}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center text-xs text-gray-400 py-2">No tables found</div>
        )
      }
      headerCountText={isLoading ? "Loading..." : sourceError ? "Unavailable" : `${remoteTables?.length ?? 0} tables`}
      headerIcon={headerIcon}
      headerLabel={selectedRemoteSource}
      headerBackgroundColor={selectedCliAppearance?.backgroundColor ?? "#f3f4f6"}
      isLoading={isLoading}
      keyForItem={(table) => table}
      onBack={onBack}
      renderItem={(table) => (
        <div
          className={`flex items-center gap-2 p-2 cursor-pointer border border-transparent hover:border-black rounded text-xs font-mono ${remoteTableHoverClassName}`}
          onClick={() => onTableSelect(table)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Database size={10} />
          {table}
        </div>
      )}
    />
  );
}
