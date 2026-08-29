import React, { useState } from "react";
import { createPortal } from "react-dom";
import { SchemaTableProps, ColumnMetadata } from "./data-source-types";
import { ColumnHoverTooltip } from "../SQLTextArea/ColumnHoverTooltip";

import { getColumnTypeColor } from "../util/column-colors";

export const SchemaTable: React.FC<SchemaTableProps> = ({
  metadata,
  selectedColumns,
  onColumnClick,
  tableName,
  columnStats,
  remoteSource,
}) => {
  const [hoveredColumn, setHoveredColumn] = useState<{
    name: string;
    type: string;
    top: number;
    left: number;
    right: number;
    width: number;
    height: number;
  } | null>(null);

  const hoverEnterTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const hoverLeaveTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const handleMouseEnter = (col: ColumnMetadata, rect: DOMRect) => {
    if (hoverLeaveTimeoutRef.current) {
      clearTimeout(hoverLeaveTimeoutRef.current);
      hoverLeaveTimeoutRef.current = null;
    }

    if (hoveredColumn?.name === col.name) return;

    setHoveredColumn({
      name: col.name,
      type: col.type,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    });
  };

  const handleMouseLeave = () => {
    if (hoverEnterTimeoutRef.current) {
      clearTimeout(hoverEnterTimeoutRef.current);
      hoverEnterTimeoutRef.current = null;
    }

    if (hoverLeaveTimeoutRef.current) {
      clearTimeout(hoverLeaveTimeoutRef.current);
    }
    hoverLeaveTimeoutRef.current = setTimeout(() => {
      setHoveredColumn(null);
    }, 200);
  };

  const handleTooltipMouseEnter = () => {
    if (hoverLeaveTimeoutRef.current) {
      clearTimeout(hoverLeaveTimeoutRef.current);
      hoverLeaveTimeoutRef.current = null;
    }
  };

  if (!metadata || metadata.length === 0) return null;

  return (
    <>
      <div className="text-xs">
        <table className="w-full text-left border-separate" style={{ borderSpacing: 0 }}>
          <thead className="font-black uppercase tracking-wider text-[10px]">
            <tr>
              <th className="p-1.5 font-black sticky top-0 z-10 bg-gray-100 border-b-2 border-black">Column</th>
              <th className="p-1.5 font-black w-1 whitespace-nowrap sticky top-0 z-10 bg-gray-100 border-b-2 border-black">
                Type
              </th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {metadata.map((col, i) => {
              const isSelected = selectedColumns?.has(col.name);
              return (
                <tr
                  key={i}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onColumnClick?.(col.name, e.shiftKey);
                  }}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleMouseEnter(col, rect);
                  }}
                  onMouseLeave={handleMouseLeave}
                  className={`border-b border-gray-200 font-mono last:border-b-0 cursor-pointer select-none transition-colors relative ${
                    isSelected ? "bg-yellow-100 hover:bg-yellow-200" : "hover:bg-yellow-50"
                  }`}
                >
                  <td className="p-1.5 font-bold truncate max-w-[150px]" title={col.name}>
                    {col.name}
                  </td>
                  <td className="p-1.5 w-1 whitespace-nowrap">
                    <span
                      className={`truncate block ${
                        getColumnTypeColor(col.type)
                          ? `px-1.5 rounded-none text-black ${getColumnTypeColor(col.type)} w-fit`
                          : "text-black"
                      }`}
                      title={col.type}
                    >
                      {col.type}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hoveredColumn &&
        createPortal(
          <div
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{
              position: "fixed",
              top: hoveredColumn.top,
              ...(hoveredColumn.left >= 300
                ? { right: window.innerWidth - hoveredColumn.left + 4 }
                : { left: hoveredColumn.right + 4 }),
              zIndex: 999999,
              pointerEvents: "auto",
            }}
          >
            <div className="pointer-events-auto shadow-xl">
              {tableName && tableName !== "Source" && (
                <ColumnHoverTooltip
                  columnName={hoveredColumn.name}
                  type={hoveredColumn.type}
                  tableName={tableName}
                  precomputedStats={columnStats?.[hoveredColumn.name]}
                  remoteSource={remoteSource}
                />
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
