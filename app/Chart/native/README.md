# Native chart implementation

`ChartUtil` always renders `NativeChart`. Scatter, line, area, and bar charts share settings, axes, hover, color legends, and PNG/SVG exports. Small plots use SVG; larger plots use Canvas. Existing chart props, migration IDs, archive formats, and annotation resize behavior remain intact. `nativeVisualization` no longer selects a renderer.

Chart types, refresh, and Options live in the right-hand action bar; X, Y, and Color remain visible across the bottom. Log scales, Y-range overrides, and row limits are no longer editing controls. Transformations and limits belong in the source SQL. Previously saved values are still honored for document compatibility.

## Data and semantics

- Mosaic Core uses the document's existing CLI DuckDB session through `/api/session/compute`. There is no browser database. Charts read the prepared result view for the upstream SQL shape, preserving its native/federated query route. The view name follows the CLI's `_kavla_result_` plus first 16 SHA-256 bytes convention; changes to that backend convention must update `source.ts`.
- Missing views use the existing result restoration helper. Its restrictions on automatic BigQuery restoration remain in effect. Dirty or running upstream queries must finish before plotting.
- No default source-row cap or random sample is applied. Explicit saved `limit` values still limit the input. Cache keys include the source revision and refresh token; SQL determines the remaining cache identity, so resize and category paging can reuse statistics.
- Scatter switches from observations to full-input bins above 10,000 eligible rows. A bin contains counts, not a representative sampled row. With color grouping, strip widths show group shares and logarithmic opacity shows total count. Without grouping, a logarithmic blue color scale shows count.
- Large lines and areas keep first/last/min/max per horizontal pixel and null-separated run, retaining source order. Stacked area reduction also retains extrema of the baseline. Use `ORDER BY` in the source query to define line order.
- Bars retain the existing first-observation-per-category-and-color behavior. They do **not** silently sum raw rows. Aggregate in the source SQL when totals are intended. Positive and negative stacks accumulate separately. Repeated coordinates in areas remain observations.
- Categorical axes preserve first-occurrence order. Width-dependent category pages expose every category with explicit navigation. Continuous axes use full eligible domains. Temporal axes use UTC timestamps; numeric log axes exclude non-positive values.
- Hover operates on plotted data with spatial/grid indexes and no extra queries. Point values are retained as source strings; density bounds are approximate and clearly labeled.
- The existing numeric-scatter selection behavior remains separate from rendering. It queries original observations, including duplicates, and honors explicit input limits. This change does not extend selection to other chart types.
- Drawing a closed outline directly in a numeric scatter plot captures a selection with the canvas Draw tool or the chart's Select shortcut. A valid completed outline transfers to `nativeSelection` in a single history transaction and its standalone draw shape is removed. Strokes starting outside the plot remain canvas drawings. Capture observes newly started gestures so completed drawings restored by undo, paste, or document loading are not adopted automatically. The polygon uses the original axis domains, with stroke color, width, dash, and opacity stored alongside it. Rendering and PNG/SVG exports project it through the current plot geometry. `drawingId` is provenance, not a dependency on a live shape. Redraw replaces the outline; Clear is undoable. Legacy saved selections without an `outline` style remain readable and can be transferred using Use existing drawing, retaining their original analytical polygon.

## ECharts compatibility

Standard charts have no ECharts render path. `legacy-widget-charts.ts` is a dynamically imported compatibility module for saved Lens programs that reference ECharts. Removing that module or the ECharts packages would break those saved programs. Normal startup, standard charts, and Lens programs without ECharts references do not import it. Historical benchmark fixtures still compare with the previous renderer.

## Validation

TypeScript, the production build, and existing selection/coordinator/series/archive compatibility checks are used for validation. Direct queries through the existing test bridge additionally exercise the active planner's full-input density counts, temporal axes, paging, limits, signed stacks, duplicate area observations, empty/log inputs, and null gaps. Build-manifest inspection verifies that the legacy chart module is outside the static startup graph.

Browser appearance, pointer interactions, and actual download behavior have not been visually verified; repository instructions require permission before viewing the app.
