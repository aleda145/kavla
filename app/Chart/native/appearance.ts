import { interpolateRgbBasis, scaleSequentialLog } from "d3";

// The legend and both renderers share the same count-to-color mapping.
export const densityColors = ["#bfdbfe", "#60a5fa", "#2563eb", "#1e3a8a"];
export function densityScale(maximum: number, selected = false) {
  return scaleSequentialLog(interpolateRgbBasis(selected ? ["#fef08a", "#eab308", "#854d0e"] : densityColors))
    .domain([1, Math.max(2, maximum)])
    .clamp(true);
}

export function pointStyle(count: number) {
  return count <= 200
    ? { radius: 5, stroke: 2 }
    : count <= 2000
      ? { radius: 3.5, stroke: 1.25 }
      : { radius: 2, stroke: 0.75 };
}

export const chartPalette = ["#8b5cf6", "#ec4899", "#3b82f6", "#eab308", "#22c55e", "#06b6d4", "#f97316", "#6366f1"];
export function groupColor(group: string | null | undefined) {
  let hash = 2166136261;
  for (const character of JSON.stringify(group ?? null)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return chartPalette[(hash >>> 0) % chartPalette.length];
}

export function densityOpacity(count: number, maximum: number) {
  return 0.25 + 0.75 * (maximum > 1 ? Math.log(Math.max(1, count)) / Math.log(maximum) : 0);
}
