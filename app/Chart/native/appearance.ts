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
