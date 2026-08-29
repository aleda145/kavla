import { SQL_RESULT_BUTTON_CLASS } from "./sql-result-area-styles";

interface SQLResultAreaFooterProps {
  isLoading: boolean;
  pageCount: number;
  pageEndRow: number;
  pageIndex: number;
  pageSize: number;
  pageStartRow: number;
  totalRows: number;
  onNextPage: () => void;
  onPreviousPage: () => void;
}

export function SQLResultAreaFooter({
  isLoading,
  pageCount,
  pageEndRow,
  pageIndex,
  pageSize,
  pageStartRow,
  totalRows,
  onNextPage,
  onPreviousPage,
}: SQLResultAreaFooterProps) {
  const previousDisabled = pageIndex === 0 || isLoading;
  const nextDisabled = pageIndex >= pageCount - 1 || isLoading;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px",
        borderTop: "4px solid #000",
        fontSize: 12,
        color: "#666",
        fontWeight: "bold",
        backgroundColor: "#f9f9f9",
        flexShrink: 0,
      }}
    >
      <span>
        {totalRows.toLocaleString()} rows
        {totalRows > 0 ? `, showing ${pageStartRow.toLocaleString()}-${pageEndRow.toLocaleString()}` : ""}
      </span>
      {totalRows > pageSize ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onPreviousPage();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.pointerType === "touch") onPreviousPage();
            }}
            disabled={previousDisabled}
            className={SQL_RESULT_BUTTON_CLASS}
            style={{
              height: 26,
              padding: "0 8px",
              backgroundColor: "#fff",
              opacity: previousDisabled ? 0.5 : 1,
              cursor: previousDisabled ? "not-allowed" : "pointer",
            }}
          >
            Prev
          </button>
          <span style={{ minWidth: 96, textAlign: "center" }}>
            Page {(pageIndex + 1).toLocaleString()} / {pageCount.toLocaleString()}
          </span>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onNextPage();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.pointerType === "touch") onNextPage();
            }}
            disabled={nextDisabled}
            className={SQL_RESULT_BUTTON_CLASS}
            style={{
              height: 26,
              padding: "0 8px",
              backgroundColor: "#fff",
              opacity: nextDisabled ? 0.5 : 1,
              cursor: nextDisabled ? "not-allowed" : "pointer",
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
