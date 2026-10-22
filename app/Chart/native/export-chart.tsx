import type { ChartData } from "./chart-data";
import { chartGeometry } from "./geometry";
import type { Point } from "./selection";
import { ScatterMarks } from "./ScatterMarks";
import { ScatterAxes } from "./ScatterAxes";
import { SeriesMarks } from "./SeriesMarks";
import { densityScale, densityOpacity, groupColor } from "./appearance";

export async function exportNativeChart(
  data: ChartData,
  width: number,
  height: number,
  polygon: Point[] | null,
  name: string,
  format: "svg" | "png"
) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const geometry = chartGeometry(width, height, data.x, data.y);
  const columns = Math.max(1, Math.floor(width / 150));
  const legendHeight = Math.ceil(data.groups.length / columns) * 22;
  const top = 40 + legendHeight,
    exportHeight = top + height + 44;
  const maximum = data.marks.reduce((max, mark) => Math.max(max, mark.count), 1);
  const scale = densityScale(maximum);
  const svg = renderToStaticMarkup(
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={exportHeight}
      viewBox={`0 0 ${width} ${exportHeight}`}
    >
      <rect width={width} height={exportHeight} fill="#fff" />
      <g fontFamily="Inter, sans-serif" fill="#000">
        <text x={16} y={25} fontWeight={800} fontSize={14}>
          {name}
        </text>
        {data.groups.map((group, i) => (
          <g
            key={JSON.stringify(group)}
            transform={`translate(${16 + (i % columns) * 150},${40 + Math.floor(i / columns) * 22})`}
          >
            <rect width={10} height={10} fill={groupColor(group)} stroke="#000" />
            <text x={16} y={9} fontSize={10}>
              <title>{group ?? "(null)"}</title>
              {(group ?? "(null)").slice(0, 20)}
            </text>
          </g>
        ))}
        <g transform={`translate(0,${top})`}>
          {data.kind === "scatter" ? (
            <ScatterMarks
              marks={data.marks}
              geometry={geometry}
              plan={data.plan}
              polygon={polygon}
              width={width}
              height={height}
              renderer="svg"
              colorBy={data.groups.length > 0}
            />
          ) : (
            <SeriesMarks data={data} geometry={geometry} width={width} height={height} renderer="svg" />
          )}
          <ScatterAxes
            geometry={geometry}
            width={width}
            height={height}
            xLabel={data.x.field + (data.x.type === "log" ? " · log" : "")}
            yLabel={data.y.field + (data.y.type === "log" ? " · log" : "")}
            polygon={polygon}
            xKind={data.xKind}
            categories={data.categories}
          />
        </g>
        <text x={16} y={exportHeight - 24} fontSize={10}>
          {data.total.toLocaleString()} input rows
          {data.kind === "bar"
            ? " · first value per category"
            : data.reduced
              ? data.kind === "scatter"
                ? " · density bins"
                : " · extrema preserved"
              : ""}
          {data.page
            ? ` · categories ${data.page.offset + 1}–${Math.min(data.page.total, data.page.offset + data.page.size)} of ${data.page.total}`
            : ""}
        </text>
        {data.plan.mode === "density" && (
          <g transform={`translate(16,${exportHeight - 16})`}>
            {Array.from({ length: 60 }, (_, i) => (
              <rect
                key={i}
                x={i}
                width={1}
                height={8}
                fill={
                  data.groups.length
                    ? `rgba(0,0,0,${densityOpacity(maximum ** (i / 59), maximum)})`
                    : scale(maximum ** (i / 59))
                }
              />
            ))}
            <text x={68} y={8} fontSize={9}>
              1–{maximum.toLocaleString()} rows / bin · log{" "}
              {data.groups.length ? "opacity · strips show group shares" : "color"}
            </text>
          </g>
        )}
      </g>
    </svg>
  );
  const svgURL = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  let url = svgURL;
  try {
    if (format === "png") {
      await document.fonts.ready;
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The chart could not be converted to PNG."));
        image.src = svgURL;
      });
      const canvas = document.createElement("canvas");
      const ratio = Math.min(2, 8192 / Math.max(width, exportHeight));
      canvas.width = Math.ceil(width * ratio);
      canvas.height = Math.ceil(exportHeight * ratio);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is required for PNG export. Export SVG instead.");
      context.scale(ratio, ratio);
      context.drawImage(image, 0, 0, width, exportHeight);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("PNG export failed."))), "image/png")
      );
      url = URL.createObjectURL(blob);
    }
    const link = document.createElement("a");
    link.download = `${name}.${format}`;
    link.href = url;
    link.click();
  } finally {
    const downloadURL = url;
    setTimeout(() => {
      URL.revokeObjectURL(svgURL);
      if (downloadURL !== svgURL) URL.revokeObjectURL(downloadURL);
    }, 1000);
  }
}
