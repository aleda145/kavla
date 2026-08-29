import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("chart-shape", {
  RemoveAutoArrowIds: 1,
  RemoveEditMode: 2,
  AddYAxisScale: 3,
  AddIsStacked: 4,
  AddLimit: 5,
  RemoveGeneratedWidgetState: 6,
});

export const ChartShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.RemoveAutoArrowIds,
      up(props) {
        delete props.autoArrowIds;
      },
      down(props) {
        props.autoArrowIds = null;
      },
    },
    {
      id: versions.RemoveEditMode,
      up(props) {
        delete props.editMode;
      },
      down(props) {
        props.editMode = true;
      },
    },
    {
      id: versions.AddYAxisScale,
      up(props) {
        props.yAxisScale = "auto";
      },
      down(props) {
        delete props.yAxisScale;
      },
    },
    {
      id: versions.AddIsStacked,
      up(props) {
        props.isStacked = false;
      },
      down(props) {
        delete props.isStacked;
      },
    },
    {
      id: versions.AddLimit,
      up(props) {
        props.limit = null;
      },
      down(props) {
        delete props.limit;
      },
    },
    {
      id: versions.RemoveGeneratedWidgetState,
      up(props) {
        delete props.renderMode;
        delete props.generatedWidget;
      },
      down(props) {
        props.renderMode = "basic";
        props.generatedWidget = null;
      },
    },
  ],
});
