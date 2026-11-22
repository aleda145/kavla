import { useEffect, useRef, useState, type UIEvent } from "react";
import { excelColumns } from "./excel-import";

export const CELL_WIDTH = 128;
export const CELL_HEIGHT = 28;
export const ROW_HEADER_WIDTH = 52;

export function useSpreadsheetViewport(rowCount: number, columnCount: number) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ top: 0, left: 0, width: 1000, height: 300 });
  useEffect(() => {
    const element = viewport.current!;
    const resize = () =>
      setSize({
        top: element.scrollTop,
        left: element.scrollLeft,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);
  function onScroll(event: UIEvent<HTMLDivElement>) {
    const { scrollTop, scrollLeft } = event.currentTarget;
    setSize((previous) => ({ ...previous, top: scrollTop, left: scrollLeft }));
  }
  const visibleRows = excelColumns(
    Math.max(0, Math.floor(size.top / CELL_HEIGHT) - 2),
    Math.min(rowCount - 1, Math.ceil((size.top + size.height) / CELL_HEIGHT))
  );
  const visibleColumns = excelColumns(
    Math.max(0, Math.floor(size.left / CELL_WIDTH) - 1),
    Math.min(columnCount - 1, Math.ceil((size.left + size.width) / CELL_WIDTH))
  );
  return { viewport, visibleRows, visibleColumns, onScroll };
}
