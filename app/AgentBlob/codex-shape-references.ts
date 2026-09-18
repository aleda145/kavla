import { renderPlaintextFromRichText, type Editor, type TLNoteShape, type TLShape } from "tldraw";

export type ContextBadge = {
  id: string;
  name: string;
  backgroundColor: string;
  borderBottomColor: string;
};

export function isContextShape(shape: TLShape) {
  return ["data-source", "sql-text-area", "sql-result-table", "chart-shape", "note", "lens-shape", "summary-shape"].includes(shape.type);
}

export function getCanvasBadges(editor: Editor): ContextBadge[] {
  const names = new Set<string>();
  return editor.getCurrentPageShapes().filter(isContextShape).map((shape) => {
    let label = "name" in shape.props && typeof shape.props.name === "string" ? shape.props.name.trim() : "";
    if (shape.type === "note") {
      label = renderPlaintextFromRichText(editor, (shape as TLNoteShape).props.richText).trim().split("\n")[0].slice(0, 50) || "note";
    }
    if (shape.type === "sql-result-table") {
      const sourceId = "sourceShapeId" in shape.props ? shape.props.sourceShapeId : null;
      const source = typeof sourceId === "string" ? editor.getShape(sourceId as TLShape["id"]) : null;
      label = source && "name" in source.props ? `${source.props.name} result` : "result";
    }
    label = (label || shape.type.replace(/-/g, " ")).replace(/[\r\n@]/g, " ");
    let name = label;
    let suffix = 2;
    while (names.has(name.toLowerCase())) name = `${label} (${suffix++})`;
    names.add(name.toLowerCase());
    const colors: Record<string, [string, string]> = {
      "data-source": ["#dbeafe", "#3b82f6"],
      "sql-text-area": ["#fef9c3", "#ca8a04"],
      "sql-result-table": ["#dcfce7", "#16a34a"],
      "chart-shape": ["#fce7f3", "#db2777"],
      "lens-shape": ["#fce7f3", "#db2777"],
      "summary-shape": ["#dcfce7", "#16a34a"],
      note: ["#ffedd5", "#f97316"],
    };
    const [backgroundColor, borderBottomColor] = colors[shape.type] ?? ["#fff", "#000"];
    return { id: shape.id, name, backgroundColor, borderBottomColor };
  });
}

export function getMentionRanges(text: string, badges: ContextBadge[]) {
  const candidates = [...badges].sort((a, b) => b.name.length - a.name.length);
  const ranges: Array<{ from: number; to: number; badge: ContextBadge }> = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@" || (index > 0 && !/[\s([{"']/.test(text[index - 1]))) continue;
    const badge = candidates.find((candidate) => {
      const end = index + candidate.name.length + 1;
      return text.slice(index + 1, end).toLowerCase() === candidate.name.toLowerCase()
        && (!text[end] || /[\s.,;:!?()[\]{}"']/.test(text[end]));
    });
    if (!badge) continue;
    const to = index + badge.name.length + 1;
    ranges.push({ from: index, to, badge });
    index = to - 1;
  }
  return ranges;
}

export function getShapeCitations(text: string) {
  return Array.from(text.matchAll(/\[([^\]\n]+)\]\((shape:[^\s)]+)\)/g), (match) => ({
    from: match.index!,
    to: match.index! + match[0].length,
    label: match[1],
    shapeId: match[2],
  }));
}
