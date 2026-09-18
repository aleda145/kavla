import type { LocalServerContextType } from "./localServer/types";

// The server bounds each page, not the total result. Null loads the complete result.
export async function loadQueryResultRows(
  getPage: LocalServerContextType["getQueryResultPage"],
  shapeId: string,
  limit: number | null = null,
  signal?: AbortSignal
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  while (limit === null || rows.length < limit) {
    signal?.throwIfAborted();
    const pageSize = limit === null ? 10000 : Math.min(10000, limit - rows.length);
    const page = await getPage({ shapeId, offset: rows.length, limit: pageSize, signal });
    signal?.throwIfAborted();
    rows.push(...page.rows);
    if (page.rows.length < pageSize) break;
  }
  return rows;
}
