import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import "./CanvasFileTable.css";

export type CanvasFileEntry = {
  name: string;
  path: string;
  modifiedAt?: string;
  size?: number;
  status?: string;
  url?: string;
};

type SortColumn = "name" | "modified" | "size" | "path";
type SortDirection = "asc" | "desc";

function formatModified(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatSize(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function CanvasFileTable({
  entries,
  onOpen,
  selectedPath,
}: {
  entries: CanvasFileEntry[];
  onOpen?: (entry: CanvasFileEntry) => void;
  selectedPath?: string | null;
}) {
  const [sortColumn, setSortColumn] = useState<SortColumn | null>("modified");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const sortedEntries = useMemo(() => {
    const sorted = [...entries];
    if (sortColumn === null) return sorted;
    sorted.sort((left, right) => {
      let comparison = 0;
      switch (sortColumn) {
        case "name":
          comparison = left.name.localeCompare(right.name);
          break;
        case "path":
          comparison = left.path.localeCompare(right.path);
          break;
        case "modified":
          if (!left.modifiedAt || !right.modifiedAt) {
            if (!left.modifiedAt && right.modifiedAt) return 1;
            if (left.modifiedAt && !right.modifiedAt) return -1;
          }
          comparison = (Date.parse(left.modifiedAt ?? "") || 0) - (Date.parse(right.modifiedAt ?? "") || 0);
          break;
        case "size":
          if (left.size === undefined || right.size === undefined) {
            if (left.size === undefined && right.size !== undefined) return 1;
            if (left.size !== undefined && right.size === undefined) return -1;
          }
          comparison = (left.size ?? 0) - (right.size ?? 0);
          break;
      }
      if (comparison !== 0) return sortDirection === "asc" ? comparison : -comparison;
      return left.name.localeCompare(right.name) || left.path.localeCompare(right.path);
    });
    return sorted;
  }, [entries, sortColumn, sortDirection]);

  const column = (key: SortColumn, label: string) => (
    <th
      key={key}
      scope="col"
      aria-sort={sortColumn === key ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        title={`Sort by ${label.toLowerCase()}; click again to reverse, then clear`}
        onClick={() => {
          const firstDirection = key === "modified" || key === "size" ? "desc" : "asc";
          if (sortColumn === key) {
            if (sortDirection !== firstDirection) {
              setSortColumn(null);
            } else {
              setSortDirection(firstDirection === "asc" ? "desc" : "asc");
            }
          } else {
            setSortColumn(key);
            setSortDirection(firstDirection);
          }
        }}
      >
        {label}
        {sortColumn === key &&
          (sortDirection === "asc" ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />)}
      </button>
    </th>
  );

  return (
    <div className="kavla-canvas-file-table-scroll">
      <table className="kavla-canvas-file-table">
        <thead>
          <tr>
            {column("name", "Name")}
            {column("modified", "Modified")}
            {column("size", "Size")}
            {column("path", "Path")}
          </tr>
        </thead>
        <tbody>
          {sortedEntries.length === 0 ? (
            <tr>
              <td colSpan={4}>No canvases are registered.</td>
            </tr>
          ) : (
            sortedEntries.map((entry) => (
              <tr key={entry.path} aria-selected={selectedPath === entry.path}>
                <td>
                  {entry.status ? (
                    <strong>{entry.name}</strong>
                  ) : onOpen ? (
                    <button type="button" className="kavla-canvas-file-table-open" onClick={() => onOpen(entry)}>
                      {entry.name}
                    </button>
                  ) : entry.url ? (
                    <a className="kavla-canvas-file-table-open" href={entry.url}>
                      {entry.name}
                    </a>
                  ) : (
                    <strong>{entry.name}</strong>
                  )}
                  {entry.status && <span className="kavla-canvas-file-table-status">{entry.status}</span>}
                </td>
                <td>{formatModified(entry.modifiedAt)}</td>
                <td>{formatSize(entry.size)}</td>
                <td>
                  <code>{entry.path}</code>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
