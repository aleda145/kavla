export interface DateDisplayOptions {
  isDateLikeColumn?: boolean;
}

export function isDateLikeColumnType(columnType: unknown) {
  const normalizedType = String(columnType ?? "").toLowerCase();
  return normalizedType.includes("date") || normalizedType.includes("time");
}

function getValidDateOrNull(date: Date) {
  return Number.isNaN(date.getTime()) ? null : date;
}

function getColumnTypeDate(value: number, normalizedType: string) {
  const absoluteValue = Math.abs(value);
  const millisecondDate = getValidDateOrNull(new Date(value));
  const millisecondYear = millisecondDate?.getUTCFullYear();
  const millisecondDateIsPlausible = Boolean(millisecondYear && millisecondYear >= 1000 && millisecondYear <= 9999);

  if (normalizedType.includes("timestamp") || normalizedType.includes("datetime")) {
    if (normalizedType.includes("nanosecond") || normalizedType.includes("timestamp_ns")) {
      return millisecondDateIsPlausible ? millisecondDate : getValidDateOrNull(new Date(value / 1_000_000));
    }
    if (normalizedType.includes("microsecond") || normalizedType.includes("timestamp_us")) {
      return millisecondDateIsPlausible ? millisecondDate : getValidDateOrNull(new Date(value / 1000));
    }
    if (
      normalizedType.includes("millisecond") ||
      normalizedType.includes("timestamp_ms") ||
      normalizedType.includes("date64")
    ) {
      return millisecondDate;
    }
    if (normalizedType.includes("second") || normalizedType.includes("timestamp_s")) {
      return getValidDateOrNull(new Date(value * 1000));
    }

    return millisecondDateIsPlausible ? millisecondDate : getValidDateOrNull(new Date(value / 1000));
  }

  if (normalizedType.includes("date")) {
    return getValidDateOrNull(new Date(absoluteValue < 1_000_000 ? value * 24 * 60 * 60 * 1000 : value));
  }

  if (normalizedType.includes("time")) {
    if (normalizedType.includes("nanosecond") || normalizedType.includes("time_ns")) {
      return getValidDateOrNull(new Date(value / 1_000_000));
    }
    if (normalizedType.includes("microsecond") || normalizedType.includes("time_us")) {
      return getValidDateOrNull(new Date(value / 1000));
    }
    if (normalizedType.includes("second")) {
      return getValidDateOrNull(new Date(value * 1000));
    }
    return getValidDateOrNull(new Date(value));
  }

  return null;
}

export function getDateFromDisplayValue(value: unknown, columnType?: unknown, options: DateDisplayOptions = {}) {
  if (value instanceof Date) {
    return getValidDateOrNull(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const normalizedType = String(columnType ?? "").toLowerCase();
    const typedDate = getColumnTypeDate(value, normalizedType);
    if (typedDate) {
      return typedDate;
    }

    const absoluteValue = Math.abs(value);
    if (options.isDateLikeColumn && absoluteValue < 1_000_000) {
      return getValidDateOrNull(new Date(value * 24 * 60 * 60 * 1000));
    }

    if (absoluteValue >= 1_000_000_000_000_000_000) return getValidDateOrNull(new Date(value / 1_000_000));
    if (absoluteValue >= 1_000_000_000_000_000) return getValidDateOrNull(new Date(value / 1000));
    if (absoluteValue >= (options.isDateLikeColumn ? 100_000_000_000 : 1_000_000_000_000)) {
      return getValidDateOrNull(new Date(value));
    }
    if (absoluteValue >= 1_000_000_000) return getValidDateOrNull(new Date(value * 1000));
    return null;
  }

  if (typeof value === "string") {
    const trimmedValue = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) {
      return getDateFromDisplayValue(Number(trimmedValue), columnType, options);
    }

    return getValidDateOrNull(new Date(value));
  }

  return null;
}

export function formatDateForDisplay(value: unknown, columnType?: unknown, options: DateDisplayOptions = {}) {
  const date = getDateFromDisplayValue(value, columnType, options);
  if (!date) {
    return null;
  }

  const isoValue = date.toISOString();
  return isoValue.endsWith("T00:00:00.000Z") ? isoValue.slice(0, 10) : isoValue;
}

export function formatDateForAxis(value: unknown, columnType?: unknown, options: DateDisplayOptions = {}) {
  const date = getDateFromDisplayValue(value, columnType, options);
  if (!date) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}
