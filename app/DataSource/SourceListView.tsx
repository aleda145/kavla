import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { TldrawScrollAreaIndicator } from "./TldrawScrollAreaIndicator";
import { useTldrawScrollArea } from "./useTldrawScrollArea";

type SourceListViewProps<T> = {
  items: T[];
  emptyState: ReactNode;
  headerCountText: string;
  headerIcon: ReactNode;
  headerLabel: string;
  headerBackgroundColor: string;
  isLoading: boolean;
  keyForItem: (item: T) => string;
  onBack: () => void;
  renderItem: (item: T) => ReactNode;
};

export function SourceListView<T>({
  items,
  emptyState,
  headerCountText,
  headerIcon,
  headerLabel,
  headerBackgroundColor,
  isLoading,
  keyForItem,
  onBack,
  renderItem,
}: SourceListViewProps<T>) {
  const scrollArea = useTldrawScrollArea();
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const isDraggingScrollbar = useRef(false);

  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollElementRef.current = node;
      scrollArea.ref(node);
    },
    [scrollArea.ref]
  );

  useEffect(() => {
    const handlePointerUp = () => {
      isDraggingScrollbar.current = false;
    };

    window.addEventListener("pointerup", handlePointerUp);
    return () => window.removeEventListener("pointerup", handlePointerUp);
  }, []);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollElementRef.current;
    if (el) {
      const { clientX, clientY } = e;
      const hasVerticalScrollbar = el.scrollHeight > el.clientHeight;
      const hasHorizontalScrollbar = el.scrollWidth > el.clientWidth;
      const rect = el.getBoundingClientRect();
      const scrollbarThickness = 16;
      const isInVerticalScrollbar =
        hasVerticalScrollbar && clientX >= rect.right - scrollbarThickness && clientX <= rect.right;
      const isInHorizontalScrollbar =
        hasHorizontalScrollbar && clientY >= rect.bottom - scrollbarThickness && clientY <= rect.bottom;

      if (isInVerticalScrollbar || isInHorizontalScrollbar) {
        isDraggingScrollbar.current = true;
        e.stopPropagation();
      }
    }

    scrollArea.onPointerDown(e);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDraggingScrollbar.current) {
      e.stopPropagation();
      return;
    }

    scrollArea.onPointerMove(e);
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    isDraggingScrollbar.current = false;
    scrollArea.onPointerUp(e);
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    isDraggingScrollbar.current = false;
    scrollArea.onPointerCancel(e);
  };

  return (
    <>
      <div
        style={{
          width: "100%",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            borderBottom: "2px solid black",
            paddingBottom: 8,
          }}
        >
          <div className="flex-1 flex justify-start min-w-0">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 8,
                minWidth: 0,
                maxWidth: "calc(100% - 84px)",
                fontSize: 12,
                fontWeight: 800,
                color: "#000",
                textAlign: "left",
                backgroundColor: headerBackgroundColor,
                border: "2px solid black",
                borderRadius: 6,
                padding: "4px 10px",
                boxShadow: "2px 2px 0px 0px rgba(0,0,0,0.2)",
              }}
            >
              {headerIcon}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {headerLabel}
              </span>
            </div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#444", whiteSpace: "nowrap" }}>{headerCountText}</div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center p-4 flex-1">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : (
          <div
            ref={setScrollRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onWheel={scrollArea.onWheel}
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              overflowY: "auto",
              overflowX: "hidden",
              borderBottom: "2px solid black",
              paddingBottom: 6,
            }}
          >
            {items.map((item) => (
              <div key={keyForItem(item)}>{renderItem(item)}</div>
            ))}
            {items.length === 0 ? emptyState : null}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-start", paddingTop: 4 }}>
          <button
            onClick={onBack}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.pointerType === "touch") onBack();
            }}
            className="text-[12px] font-bold hover:underline bg-white px-2 py-1 rounded border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-all active:translate-y-[1px]"
          >
            &lt; Back
          </button>
        </div>
      </div>
      <TldrawScrollAreaIndicator indicator={scrollArea.indicator} />
    </>
  );
}
