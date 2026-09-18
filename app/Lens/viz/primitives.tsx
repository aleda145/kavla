import React from "react";

export type LensVizTheme = {
  fontFamily: string;
  borderColor: string;
  colors: string[];
  background: string;
  surface: string;
  header: string;
  borderWidth: number;
  radius: number;
  shadow: string;
};

export type LensVizLegendItem = {
  label: string;
  color: string;
  value?: string | number | null;
};

export type LensVizCategoricalColors = string[] & {
  colorByLabel: Map<string, string>;
  byLabel: Record<string, string>;
  colorFor: (label: string | number | null | undefined) => string;
  get: (label: string | number | null | undefined) => string;
  items: LensVizLegendItem[];
  legendItems: LensVizLegendItem[];
  colors: string[];
  palette: string[];
};

export type LensVizHoverState = {
  x: number;
  y: number;
  title?: string | null;
  lines?: string[];
  content?: React.ReactNode;
  data?: unknown;
  coordinateSpace?: "local" | "viewport";
} | null;

const FALLBACK_COLORS = ["#8b5cf6", "#ec4899", "#3b82f6", "#eab308", "#22c55e", "#14b8a6", "#f97316"];

function getFont(theme?: LensVizTheme) {
  return theme?.fontFamily || "Inter, sans-serif";
}

export function formatValue(
  value: unknown,
  options: { unit?: string; maximumFractionDigits?: number; decimals?: number; fallback?: string } = {}
) {
  if (value === null || value === undefined || value === "") {
    return options.fallback ?? "n/a";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value.toLocaleString(undefined, {
      maximumFractionDigits: options.decimals ?? options.maximumFractionDigits ?? (Math.abs(value) < 10 ? 2 : 1),
    })}${options.unit ? ` ${options.unit}` : ""}`;
  }
  if (value instanceof Date) {
    return value.toLocaleDateString();
  }
  return String(value);
}

export function getCategoricalColors(labels: Array<string | number | null | undefined>, theme?: LensVizTheme) {
  const palette = theme?.colors?.length ? theme.colors : FALLBACK_COLORS;
  const fallbackColor = palette[0] ?? "#8b5cf6";
  const uniqueLabels = Array.from(
    new Set(labels.filter((label) => label !== null && label !== undefined && String(label).trim() !== "").map(String))
  );
  const colorByLabel = new Map(
    uniqueLabels.map((label, index) => [label, palette[index % palette.length] ?? fallbackColor])
  );
  const byLabel = Object.fromEntries(colorByLabel);
  const items = uniqueLabels.map((label) => ({ label, color: colorByLabel.get(label) ?? fallbackColor }));
  const assignedColors = items.map((item) => item.color);
  const result = [...assignedColors] as LensVizCategoricalColors;
  const colorFor = (label: string | number | null | undefined) =>
    colorByLabel.get(String(label ?? "")) ?? fallbackColor;

  Object.defineProperties(result, {
    colorByLabel: { value: colorByLabel },
    byLabel: { value: byLabel },
    colorFor: { value: colorFor },
    get: { value: colorFor },
    items: { value: items },
    legendItems: { value: items },
    colors: { value: assignedColors },
    palette: { value: palette },
    forEach: { value: items.forEach.bind(items) },
    map: { value: items.map.bind(items) },
    filter: { value: items.filter.bind(items) },
    find: { value: items.find.bind(items) },
  });
  Object.defineProperty(result, Symbol.iterator, { value: items[Symbol.iterator].bind(items) });

  return result;
}

export function useHover() {
  const [hover, setHover] = React.useState<LensVizHoverState>(null);
  const setNormalizedHover = React.useCallback((nextHover: React.SetStateAction<LensVizHoverState>) => {
    setHover((currentHover) => {
      const resolvedHover = typeof nextHover === "function" ? nextHover(currentHover) : nextHover;
      return resolvedHover ? { coordinateSpace: "viewport", ...resolvedHover } : null;
    });
  }, []);
  const showHover = (
    event?: React.PointerEvent<Element> | { clientX?: number; clientY?: number } | null,
    content:
      | {
          title?: string | null;
          lines?: Array<string | number | null | undefined>;
          content?: React.ReactNode;
          data?: unknown;
        }
      | Array<string | number | null | undefined> = []
  ) => {
    const currentTarget =
      event && "currentTarget" in event && event.currentTarget instanceof Element ? event.currentTarget : null;
    const owner =
      currentTarget instanceof SVGElement ? (currentTarget.ownerSVGElement ?? currentTarget) : currentTarget;
    const bounds = owner?.getBoundingClientRect();
    const normalized = Array.isArray(content) ? { lines: content } : content;
    setHover({
      x: (event?.clientX ?? 0) - (bounds?.left ?? 0) + 12,
      y: (event?.clientY ?? 0) - (bounds?.top ?? 0) + 12,
      title: normalized.title ?? null,
      lines: (normalized.lines ?? [])
        .filter((line) => line !== null && line !== undefined && String(line).trim() !== "")
        .map((line) => String(line)),
      content: normalized.content,
      data: normalized.data,
      coordinateSpace: bounds ? "local" : "viewport",
    });
  };
  const hideHover = () => setHover(null);
  return { hover, showHover, hideHover, setHover: setNormalizedHover };
}

export function getMargins(
  input: {
    width?: number;
    height?: number;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    hasLegend?: boolean;
    hasFooter?: boolean;
    dense?: boolean;
  } = {}
) {
  const dense = Boolean(input.dense || (input.width !== undefined && input.width < 420));
  return {
    left: input.left ?? (dense ? 40 : 56),
    right: input.right ?? (dense ? 16 : 24),
    top: input.top ?? (dense ? 12 : 18),
    bottom: input.bottom ?? (input.hasFooter ? 48 : input.hasLegend ? 54 : dense ? 36 : 44),
  };
}

export function Frame({
  children,
  width = "100%",
  height = "100%",
  padding = 10,
  theme,
  style,
}: {
  children: React.ReactNode;
  width?: number | string;
  height?: number | string;
  padding?: number;
  theme?: LensVizTheme;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        boxSizing: "border-box",
        padding,
        overflow: "hidden",
        background: theme?.background || "#fff",
        color: "#111827",
        fontFamily: getFont(theme),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Legend({
  items,
  maxItems = 10,
  direction = "row",
  theme,
}: {
  items: LensVizLegendItem[];
  maxItems?: number;
  direction?: "row" | "column";
  theme?: LensVizTheme;
}) {
  const visibleItems = items.slice(0, maxItems);
  if (visibleItems.length <= 1) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: direction,
        flexWrap: "wrap",
        gap: direction === "row" ? "6px 12px" : 6,
        alignItems: direction === "row" ? "center" : "flex-start",
        fontFamily: getFont(theme),
        fontSize: 11,
        fontWeight: 850,
      }}
    >
      {visibleItems.map((item, index) => (
        <div
          key={`${item.label}:${index}`}
          title={item.label}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}
        >
          <span
            style={{ width: 12, height: 12, border: "1.5px solid #000", background: item.color, flex: "0 0 auto" }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
          {item.value !== null && item.value !== undefined ? (
            <span style={{ color: "#6b7280" }}>{formatValue(item.value)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Tooltip({
  hover,
  x,
  y,
  children,
  theme,
  onMouseEnter,
  onMouseLeave,
}: {
  hover?: LensVizHoverState;
  x?: number;
  y?: number;
  children?: React.ReactNode;
  theme?: LensVizTheme;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const left = hover?.x ?? x;
  const top = hover?.y ?? y;
  if (left === undefined || top === undefined) return null;
  const coordinateSpace = hover?.coordinateSpace ?? (hover ? "local" : "viewport");
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: coordinateSpace === "viewport" ? "fixed" : "absolute",
        left,
        top,
        transform: "translate(10px, calc(-100% - 10px))",
        maxWidth: 260,
        padding: "7px 9px",
        border: "2px solid #000",
        borderRadius: 4,
        background: theme?.surface || "#fff",
        boxShadow: "3px 3px 0px 0px rgba(0,0,0,1)",
        fontFamily: getFont(theme),
        fontSize: 11,
        fontWeight: 800,
        lineHeight: 1.25,
        color: "#111827",
        pointerEvents: onMouseEnter || onMouseLeave ? "auto" : "none",
        zIndex: 5,
      }}
    >
      {children ??
        hover?.content ??
        (hover ? (
          <>
            {hover.title ? <div style={{ marginBottom: 4, fontWeight: 950 }}>{hover.title}</div> : null}
            {(hover.lines ?? []).map((line, index) => (
              <div key={`${line}:${index}`}>{line}</div>
            ))}
          </>
        ) : null)}
    </div>
  );
}

export function EmptyState({ message = "No rows to show.", theme }: { message?: string; theme?: LensVizTheme }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        textAlign: "center",
        fontFamily: getFont(theme),
        fontWeight: 900,
        color: "#111827",
      }}
    >
      {message}
    </div>
  );
}

export function Footer({
  rowCount,
  visibleRows,
  note,
  left,
  right,
  theme,
}: {
  rowCount?: number;
  visibleRows?: number;
  note?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  theme?: LensVizTheme;
}) {
  const countText =
    rowCount === undefined
      ? null
      : visibleRows !== undefined && visibleRows !== rowCount
        ? `${visibleRows.toLocaleString()} of ${rowCount.toLocaleString()} rows`
        : `${rowCount.toLocaleString()} rows`;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: getFont(theme),
        fontSize: 10,
        fontWeight: 850,
        color: "#4b5563",
        minWidth: 0,
      }}
    >
      <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {left ?? note ?? countText}
      </div>
      {right ? <div style={{ flex: "0 0 auto" }}>{right}</div> : null}
    </div>
  );
}

export function Palette({
  labels,
  theme,
}: {
  labels: Array<string | number | null | undefined>;
  theme?: LensVizTheme;
}) {
  const palette = getCategoricalColors(labels, theme);
  return <Legend items={palette.items} theme={theme} />;
}
