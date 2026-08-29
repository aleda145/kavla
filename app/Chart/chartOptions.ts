import {
  formatDateForAxis,
  formatDateForDisplay,
  getDateFromDisplayValue,
  isDateLikeColumnType,
} from "../util/date-formatting";

const X_AXIS_LABEL_MAX_CHARS = 15;

function truncateXAxisLabel(value: unknown) {
  const text = String(value);
  // TODO: Make this dynamic based on chart width, tick count, and rotation instead of a fixed character limit.
  return text.length > X_AXIS_LABEL_MAX_CHARS ? `${text.slice(0, X_AXIS_LABEL_MAX_CHARS - 3)}...` : text;
}

function isDateColumn(columnName: string | null, columnType: string | undefined) {
  if (isDateLikeColumnType(columnType)) {
    return true;
  }

  const normalizedName = (columnName ?? "").toLowerCase();
  return ["date", "time", "timestamp", "day", "month", "year", "created_at", "updated_at"].some((part) =>
    normalizedName.includes(part)
  );
}

function formatChartDate(value: unknown, columnType?: string, isDateLikeColumn = false) {
  return formatDateForDisplay(value, columnType, { isDateLikeColumn }) ?? truncateXAxisLabel(value);
}

function formatChartAxisDate(value: unknown, columnType?: string, isDateLikeColumn = false) {
  return formatDateForAxis(value, columnType, { isDateLikeColumn }) ?? truncateXAxisLabel(value);
}

function normalizeChartValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }

  if (value instanceof Date) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeChartValue);
  }

  if (typeof value === "object" && value !== null) {
    const primitiveValue = value.valueOf();
    if (primitiveValue !== value && typeof primitiveValue !== "object") {
      return normalizeChartValue(primitiveValue);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        normalizeChartValue(nestedValue),
      ])
    );
  }

  return value;
}

export function normalizeChartRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeChartValue(value)]));
}

interface BuildChartOptionOptions {
  chartHeight: number;
  chartType: string | null;
  color: string | null;
  columnTypes: Record<string, string>;
  data: Record<string, any>[];
  isStacked: boolean;
  resolvedYAxisScale: string;
  x: string | null;
  y: string | null;
}

export function buildChartOption({
  chartHeight,
  chartType,
  color,
  columnTypes,
  data,
  isStacked,
  resolvedYAxisScale,
  x,
  y,
}: BuildChartOptionOptions) {
  if (!data.length || !x || !y) return {};

  const validData = data.map((datum) => {
    const normalizedDatum = normalizeChartRow(datum);
    const newData = { ...normalizedDatum, [x]: normalizedDatum[x] ?? "Null" };
    if (color) {
      newData[color] = normalizedDatum[color] ?? "Null";
    }
    return newData;
  });

  const xIsDate = isDateColumn(x, columnTypes[x]);
  const colorIsDate = color ? isDateColumn(color, columnTypes[color]) : false;
  const isXNumeric = validData.every((datum) => typeof datum[x] === "number");
  const xAxisType = chartType === "bar" ? "category" : xIsDate ? "time" : isXNumeric ? "value" : "category";
  const isCategoricalXAxis = xAxisType === "category";
  const getCategoryKey = (value: unknown) => String(value);
  const getXChartValue = (value: unknown) => {
    if (!xIsDate || xAxisType === "category") {
      return value;
    }

    return getDateFromDisplayValue(value, columnTypes[x], { isDateLikeColumn: xIsDate })?.getTime() ?? value;
  };
  const formatColorValue = (value: unknown) =>
    colorIsDate && color ? formatChartDate(value, columnTypes[color], colorIsDate) : String(value);

  // Splitting into color series must not change the x-axis ordering.
  const globalXOrder = isCategoricalXAxis
    ? Array.from(new Set(validData.map((datum) => getCategoryKey(datum[x]))))
    : undefined;

  let maxLabelLen = 0;
  const sampleSize = Math.min(validData.length, 100);
  for (let i = 0; i < sampleSize; i++) {
    const valStr = String(validData[i][x]);
    if (valStr.length > maxLabelLen) maxLabelLen = valStr.length;
  }

  const estimatedLabelHeight = isXNumeric ? 20 : Math.min(maxLabelLen * 5 + 10, 80);

  // Bucket the height to limit ECharts updates during resize.
  const heightBucket = Math.round(chartHeight / 25) * 25;
  const safeBottomMargin = heightBucket * 0.15;
  const idealNameGap = estimatedLabelHeight + 15;
  const xNameGap = Math.max(30, Math.min(idealNameGap, estimatedLabelHeight + safeBottomMargin - 20));

  const commonFontCurrent = "Inter, sans-serif";
  const commonColor = "#000";
  const thickBorder = 3;

  const axisStyle = {
    axisLine: {
      show: true,
      lineStyle: {
        color: commonColor,
        width: thickBorder,
        type: "solid",
      },
    },
    axisTick: {
      show: true,
      length: 8,
      lineStyle: {
        color: commonColor,
        width: thickBorder,
      },
    },
    axisLabel: {
      color: commonColor,
      fontWeight: "bold",
      fontFamily: commonFontCurrent,
      fontSize: 12,
    },
    nameTextStyle: {
      color: commonColor,
      fontWeight: "bold",
      fontFamily: commonFontCurrent,
      fontSize: 14,
    },
    splitLine: {
      show: false,
      lineStyle: {
        color: commonColor,
        width: 1,
        type: "dashed",
        opacity: 0.3,
      },
    },
  };

  const groups = new Map<unknown, Record<string, any>[]>();
  if (color) {
    validData.forEach((datum) => {
      const key = datum[color];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(datum);
    });
  }

  const palette = ["#8b5cf6", "#ec4899", "#3b82f6", "#eab308", "#22c55e"];

  const seriesList: any[] = [];
  const commonSeriesProps = {
    symbolSize: chartType === "scatter" ? 10 : 8,
    symbol: "circle",
    smooth: true,
    lineStyle: {
      width: 4,
    },
    itemStyle: {
      borderColor: "#000",
      borderWidth: chartType === "scatter" || chartType === "line" || chartType === "area" ? 2 : 0,
    },
  };

  if (color) {
    let colorIndex = 0;
    groups.forEach((groupData, key) => {
      let seriesType = chartType;
      let areaStyle = undefined;
      if (chartType === "area") {
        seriesType = "line";
        areaStyle = { opacity: isStacked ? 0.8 : 0.3 };
      }

      let stack = undefined;
      if (isStacked && (chartType === "bar" || chartType === "area")) {
        stack = "total";
      }

      const seriesData =
        chartType === "bar" && globalXOrder
          ? globalXOrder.map((category) => {
              const row = groupData.find((datum) => getCategoryKey(datum[x]) === category);
              return row ? row[y] : null;
            })
          : groupData.map((datum) => [getXChartValue(datum[x]), datum[y]]);

      seriesList.push({
        ...commonSeriesProps,
        name: formatColorValue(key),
        type: seriesType,
        data: seriesData,
        areaStyle,
        stack,
        itemStyle: {
          color: palette[colorIndex % palette.length],
          borderColor: "#000",
          borderWidth: chartType === "scatter" || chartType === "line" ? 2 : 0,
        },
        emphasis: { focus: "series" },
        z: isStacked ? 2 : seriesList.length + 2,
      });
      colorIndex++;
    });
  } else {
    let seriesType = chartType;
    let areaStyle = undefined;
    if (chartType === "area") {
      seriesType = "line";
      areaStyle = { opacity: isStacked ? 0.8 : 0.3 };
    }

    const seriesData =
      chartType === "bar" && globalXOrder
        ? globalXOrder.map((category) => {
            const row = validData.find((datum) => getCategoryKey(datum[x]) === category);
            return row ? row[y] : null;
          })
        : validData.map((datum) => [getXChartValue(datum[x]), datum[y]]);

    seriesList.push({
      ...commonSeriesProps,
      name: y,
      type: seriesType,
      data: seriesData,
      itemStyle: {
        color: palette[0],
        borderColor: "#000",
        borderWidth: chartType === "scatter" || chartType === "line" ? 2 : 0,
      },
      areaStyle,
    });
  }

  return {
    color: palette,
    backgroundColor: "transparent",
    textStyle: {
      fontFamily: commonFontCurrent,
    },
    grid: {
      top: "15%",
      bottom: "15%",
      left: "15%",
      right: "10%",
      containLabel: true,
      borderColor: "#000",
      borderWidth: 0,
      show: false,
    },
    tooltip: {
      trigger: "axis",
      confine: true,
      backgroundColor: "#fff",
      borderColor: "#000",
      borderWidth: 2,
      padding: [8, 12],
      textStyle: {
        color: "#000",
        fontFamily: commonFontCurrent,
        fontWeight: "bold",
        fontSize: 12,
      },
      extraCssText: "box-shadow: 4px 4px 0px 0px rgba(0,0,0,1); border-radius: 0;",
      formatter: (params: any) => {
        const points = Array.isArray(params) ? params : [params];
        return points
          .map((point) => {
            const rawX = Array.isArray(point?.value) ? point.value[0] : (point?.axisValue ?? point?.name);
            const rawY = Array.isArray(point?.value) ? point.value[1] : point?.value;
            const xLabel = xIsDate ? formatChartDate(rawX, columnTypes[x], xIsDate) : rawX;
            const marker = point?.marker ?? "";
            const seriesName = point?.seriesName && point.seriesName !== y ? `${point.seriesName}: ` : "";
            return `${marker}${x}: ${xLabel}<br/>${seriesName}${y}: ${rawY}`;
          })
          .join("<br/>");
      },
      axisPointer: {
        type: "cross",
        label: {
          backgroundColor: "#000",
          color: "#fff",
          fontWeight: "bold",
        },
        lineStyle: {
          color: "#000",
          width: 1,
          type: "dashed",
        },
      },
    },
    legend: {
      show: !!color,
      top: 0,
      type: "scroll",
      textStyle: {
        color: "#000",
        fontWeight: "bold",
        fontFamily: commonFontCurrent,
      },
      itemWidth: 16,
      itemHeight: 16,
      itemGap: 16,
    },
    xAxis: {
      type: xAxisType,
      data: globalXOrder,
      name: x,
      nameLocation: "middle",
      nameGap: xNameGap,
      ...axisStyle,
      axisLabel: {
        ...axisStyle.axisLabel,
        rotate: 45,
        hideOverlap: true,
        formatter: (value: unknown) =>
          xIsDate ? formatChartAxisDate(value, columnTypes[x], xIsDate) : truncateXAxisLabel(value),
      },
    },
    yAxis: {
      type: "value",
      name: y,
      scale: resolvedYAxisScale !== "zero",
      ...axisStyle,
    },

    series: seriesList,
  };
}
