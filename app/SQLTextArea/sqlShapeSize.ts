export const SQL_SHAPE_MIN_WIDTH = 400;
export const SQL_SHAPE_MIN_HEIGHT = 300;
export const SQL_SHAPE_MAX_WIDTH = 600;
export const SQL_SHAPE_MAX_HEIGHT = 600;

export function getAutoExpandedSQLShapeSize(
  sqlText: string,
  currentSize: { w: number; h: number } = { w: SQL_SHAPE_MIN_WIDTH, h: SQL_SHAPE_MIN_HEIGHT },
) {
  const lines = sqlText.split("\n");
  const longestLineLength = lines.reduce((longest, line) => Math.max(longest, line.length), 0);
  const estimatedWidth = longestLineLength * 8.4 + 150;
  const estimatedHeight = lines.length * 19 + 120;

  return {
    w: Math.max(
      currentSize.w,
      Math.min(SQL_SHAPE_MAX_WIDTH, Math.max(SQL_SHAPE_MIN_WIDTH, Math.ceil(estimatedWidth))),
    ),
    h: Math.max(
      currentSize.h,
      Math.min(SQL_SHAPE_MAX_HEIGHT, Math.max(SQL_SHAPE_MIN_HEIGHT, Math.ceil(estimatedHeight))),
    ),
  };
}
