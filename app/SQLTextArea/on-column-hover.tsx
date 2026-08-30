import { createRoot } from "react-dom/client";
import { ColumnHoverTooltip } from "./ColumnHoverTooltip";
import type { RemoteSourceInfo } from "./remote-column-stats";
import { applyTooltipPlacementStyle } from "./tooltip-position";
import { INTERACTIVE_HOVER_TOOLTIP_CLASS, type HoverSource } from "./grace-period-hover";
import {
  createSqlNameLookup,
  findMentionedTables,
  findSqlIdentifierAt,
  getRelevantColumns,
  shouldSuppressColumn,
  type SqlColumnDefinition,
} from "./sql-identifiers";

export const getColumnHoverSource = (
  columnMapping: Record<string, SqlColumnDefinition[]>,
  validTableNames: Set<string>,
  upstreamTableNames: string[],
  onTooltipActive?: (active: boolean) => void,
  remoteSourceMap?: Map<string, RemoteSourceInfo>,
  localTableLoaders?: Map<string, () => Promise<void>>
): HoverSource => {
  const tableNames = createSqlNameLookup(validTableNames);
  const upstreamTables = new Set(upstreamTableNames);

  return (view, pos, side) => {
    const { from, text } = view.state.doc.lineAt(pos);
    const identifier = findSqlIdentifierAt(text, pos - from);
    if (!identifier) return null;

    const start = from + identifier.from;
    const end = from + identifier.to;
    if ((start == pos && side < 0) || (end == pos && side > 0) || start === end) return null;

    const word = identifier.name;
    const candidates = columnMapping[word.toLowerCase()];

    if (!candidates) return null;

    const docText = view.state.doc.toString();
    if (shouldSuppressColumn(docText, { name: word, from: start, to: end })) return null;

    const mentionedTables = findMentionedTables(docText, tableNames);
    const relevant = getRelevantColumns(candidates, upstreamTables, mentionedTables);

    // Deduplicate by type, keeping the candidate object
    const unique = new Map<string, SqlColumnDefinition>();
    relevant.forEach((c) => unique.set(c.type, c));

    if (unique.size === 0) return null;

    return {
      pos: start,
      end,
      above: true,
      create(_view) {
        if (onTooltipActive) onTooltipActive(true);
        const dom = document.createElement("div");
        dom.classList.add(INTERACTIVE_HOVER_TOOLTIP_CLASS);
        requestAnimationFrame(() => {
          applyTooltipPlacementStyle(_view, start, dom);
        });

        const root = createRoot(dom);

        const TooltipList = () => (
          <div className="pointer-events-auto flex flex-col gap-2">
            {Array.from(unique.entries()).map(([type, candidate]) => (
              <ColumnHoverTooltip
                key={`${candidate.tableName}-${word}-${type}`}
                columnName={candidate.name}
                type={type}
                tableName={candidate.tableName}
                remoteSource={remoteSourceMap?.get(candidate.tableName) ?? null}
                prepareLocalTable={localTableLoaders?.get(candidate.tableName) ?? null}
              />
            ))}
          </div>
        );

        root.render(<TooltipList />);

        return {
          dom,
          destroy: () => {
            root.unmount();
            if (onTooltipActive) onTooltipActive(false);
          },
        };
      },
    };
  };
};
