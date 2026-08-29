export type ColumnStats = {
  type: "numeric" | "text" | "temporal" | "other";
  min?: any;
  max?: any;
  topValues?: { value: any; count: number; isOther?: boolean }[];
  histogram?: { bin: number; count: number; start: number; end: number }[];
  nullCount?: number;
  nullPercentage?: number;
  distinctCount?: number;
  error?: string;
};
