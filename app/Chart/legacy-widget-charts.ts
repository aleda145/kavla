// Saved Lens programs may call arbitrary ECharts APIs. Keep this compatibility
// module isolated: standard Kavla charts never import or execute it.
import ReactECharts from "echarts-for-react";
import * as ECharts from "echarts";
export { ECharts };
export const ReactEChartsRuntime = Object.assign(ReactECharts, { graphic: ECharts.graphic });
