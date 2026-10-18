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
  isAliasDeclaration,
  isFunctionCall,
  type SqlColumnDefinition,
} from "./sql-identifiers";

export const getColumnHoverSource = (
  columnMapping: Record<string, SqlColumnDefinition[]>,
  validTableNames: Set<string>,
  upstreamTableNames: string[],
  onTooltipActive?: (active: boolean) => void,
  remoteSourceMap?: Map<string, RemoteSourceInfo>,
  localTableLoaders?: Map<string, () => Promise<void>>,
  currentTableName?: string
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
    if (isFunctionCall(docText, end)) return null;
    const ownColumn = candidates.find(
      (candidate) => candidate.tableName === currentTableName && candidate.documentation
    );
    const isAlias = isAliasDeclaration(docText, start);
    if (isAlias && !ownColumn) return null;

    const mentionedTables = findMentionedTables(docText, tableNames);
    const qualified = /\.\s*$/.test(docText.slice(0, start));
    const relevant =
      ownColumn && !qualified ? [ownColumn] : getRelevantColumns(candidates, upstreamTables, mentionedTables);

    // Keep documentation from distinct tables separate.
    const unique = new Map<string, SqlColumnDefinition>();
    relevant.forEach((c) => unique.set(`${c.tableName}\0${c.type}`, c));

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
            {Array.from(unique.entries()).map(([key, candidate]) => (
              <ColumnHoverTooltip
                key={key}
                columnName={candidate.name}
                type={candidate.type}
                documentation={candidate.documentation}
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
