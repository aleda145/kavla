import type { Editor } from "tldraw";
import type { SQLTextAreaShape } from "../../SQLTextArea/sql-text-area-types";
import { isBizMode } from "./bizMode";
import {
  getSQLBizCardHeight,
  getSQLBizColumns,
  getSQLBizSummary,
  SQL_BIZ_CARD_GAP,
} from "../../SQLTextArea/sqlBizSummary";

export function fitQueryNodes(editor: Editor): void {
  if (editor.getIsReadonly()) return;
  const queries = editor
    .getCurrentPageShapes()
    .filter(
      (shape): shape is SQLTextAreaShape => shape.type === "sql-text-area" && !editor.isShapeOrAncestorLocked(shape)
    );
  if (!queries.length) return;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("Could not measure query text.");
  const justIcons = document.documentElement.hasAttribute("data-kavla-just-icons");
  const measure = (text: string, font: string) => {
    context.font = font;
    return context.measureText(text).width;
  };
  const fitted = queries.map((shape) => {
    const props = shape.props;
    // Measure every line, including queries outside the viewport. Tabs use the
    // static SQL preview's eight-column stops; fitting must also work when culled.
    const lines = props.text.split(/\r?\n/).map((line) => {
      let column = 0;
      return Array.from(line, (character) => {
        const length = character === "\t" ? 8 - (column % 8) : 1;
        column += length;
        return character === "\t" ? " ".repeat(length) : character;
      }).join("");
    });
    const sqlWidth = lines.reduce((width, line) => Math.max(width, measure(line, "14px monospace")), 0);
    const gutterWidth = measure(String(lines.length), "14px monospace") + 24;
    const actionWidth = justIcons
      ? 56
      : Math.max(
          measure("Query", "700 12px Inter, sans-serif") + 72,
          measure(props.isRunning ? "Running" : "Run", "900 12px Inter, sans-serif") + 80
        );
    const headerWidth =
      measure(props.name, "800 14.4px Inter, sans-serif") +
      props.name.length * 0.5 +
      96 +
      (props.isDirty ? 20 : 0) +
      (props.stale ? 70 : 0);
    let footerWidth = 0;
    let footerHeight = 0;
    if (props.isRunning && props.queryStartTime) {
      footerWidth = measure(`${props.runnerName ?? "CLI"} is running (999.9s)`, "700 12px Inter, sans-serif") + 24;
      footerHeight = 38;
    } else if (props.error) {
      footerHeight = Math.max(72, (props.error.split("\n").length + 1) * 18 + 20);
    } else if (props.lastRunStats) {
      const { runnerName, executionTime, rowCount } = props.lastRunStats;
      footerWidth =
        measure(
          `${runnerName} ran query in ${(executionTime / 1000).toFixed(2)}s · ${rowCount.toLocaleString()} rows`,
          "700 12px Inter, sans-serif"
        ) + 32;
      footerHeight = 38;
    }
    // Four 36px action buttons, three 8px gaps and 16px padding need 184px.
    // Include the header (44px), outer border (8px), and any execution footer.
    let w = Math.ceil(Math.max(240, sqlWidth + gutterWidth + actionWidth + 16, headerWidth, footerWidth));
    let h = Math.ceil(44 + 8 + Math.max(184, lines.length * 14 * 1.43 + 8) + footerHeight);
    if (isBizMode(editor, shape.id)) {
      const summary = getSQLBizSummary(props.text);
      const measurePipeline = (availableWidth: number) => {
        // Use the same card and nested CTE dimensions as SQLBizBody. Keep the
        // current wrapping width as a starting point, then trim unused space.
        const columns = getSQLBizColumns(summary, { w: availableWidth, h: 0 });
        const rows: number[] = [];
        summary.steps.forEach((step, index) => {
          const row = Math.floor(index / columns.length);
          rows[row] = Math.max(rows[row] ?? 0, getSQLBizCardHeight(step, availableWidth));
        });
        let width =
          columns.reduce((sum, column) => sum + column, 0) + Math.max(0, columns.length - 1) * SQL_BIZ_CARD_GAP;
        let height = rows.reduce((sum, row) => sum + row, 0) + Math.max(0, rows.length - 1) * SQL_BIZ_CARD_GAP;
        if (!summary.steps.length && !summary.error) {
          width = measure(summary.note ?? "No query yet.", "12px Inter, sans-serif") + 30;
          height = 46;
        }
        if (summary.error) {
          const errorWidth = Math.max(160, availableWidth);
          const errorLines = summary.error.split("\n");
          width = Math.max(
            width,
            Math.min(errorWidth, Math.max(...errorLines.map((line) => measure(line, "12px monospace"))))
          );
          height +=
            (summary.steps.length ? 12 : 0) +
            errorLines.reduce(
              (sum, line) => sum + Math.max(1, Math.ceil(measure(line, "12px monospace") / errorWidth)),
              0
            ) *
              18;
        }
        return { w: width, h: height };
      };
      // Biz content has 14px side padding, 12px top/bottom padding, plus the
      // node's 4px border. Measure from data so offscreen queries fit too.
      const horizontalChrome = actionWidth + 28 + 8;
      const pipeline = measurePipeline(Math.max(160, props.w - horizontalChrome));
      w = Math.ceil(Math.max(240, pipeline.w + horizontalChrome, headerWidth, footerWidth));
      h = Math.ceil(44 + 8 + Math.max(184, measurePipeline(w - horizontalChrome).h + 24) + footerHeight);
    }
    return { ...shape, props: { ...props, w, h, isManuallyResized: true } };
  });

  editor.markHistoryStoppingPoint("fit-query-nodes");
  editor.run(() => {
    // Treat this as an explicit resize: automatic query growth/reflow must not
    // move the query or its linked table as a side effect of fitting it.
    editor.updateShapes<SQLTextAreaShape>(
      fitted.map((shape) => ({
        id: shape.id,
        type: shape.type,
        props: { w: shape.props.w, h: shape.props.h, isManuallyResized: true },
      }))
    );
  });
  editor.markHistoryStoppingPoint("fit-query-nodes-complete");
}
