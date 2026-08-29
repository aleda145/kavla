import {
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  tableFeatures,
  type Table,
} from "@tanstack/react-table";

export const SQL_RESULT_TABLE_FEATURES = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
  columnVisibilityFeature,
});

export type SQLResultRow = Record<string, unknown>;
export type SQLResultTable = Table<typeof SQL_RESULT_TABLE_FEATURES, SQLResultRow>;
