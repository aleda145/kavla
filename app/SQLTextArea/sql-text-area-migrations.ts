import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds(
  // this must match the shape type in the shape definition
  "sql-text-area",
  {
    AddError: 1,
    AddIsRunning: 2,
    AddIsDirty: 3,
    AddQueryStartTime: 4,
    AddShowTable: 5,
    AddRunnerName: 6,
    AddLastRunStats: 7,
    AddOutputSchema: 8,
    AddIsManuallyResized: 9,
    AddColumnStats: 10,
  }
);

export const SQLTextAreaMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.AddError,
      up(props) {
        // it is safe to mutate the props object here
        props.error = null;
      },
      down(props) {
        delete props.error;
      },
    },
    {
      id: versions.AddIsRunning,
      up(props) {
        // it is safe to mutate the props object here
        props.isRunning = false;
      },
      down(props) {
        delete props.isRunning;
      },
    },
    {
      id: versions.AddIsDirty,
      up(props) {
        props.isDirty = false;
      },
      down(props) {
        delete props.isDirty;
      },
    },
    {
      id: versions.AddQueryStartTime,
      up(props) {
        props.queryStartTime = null;
      },
      down(props) {
        delete props.queryStartTime;
      },
    },
    {
      id: versions.AddShowTable,
      up(props) {
        props.showTable = true;
      },
      down(props) {
        delete props.showTable;
      },
    },
    {
      id: versions.AddRunnerName,
      up(props) {
        props.runnerName = null;
      },
      down(props) {
        delete props.runnerName;
      },
    },
    {
      id: versions.AddLastRunStats,
      up(props) {
        props.lastRunStats = null;
      },
      down(props) {
        delete props.lastRunStats;
      },
    },
    {
      id: versions.AddOutputSchema,
      up(props) {
        props.outputSchema = null;
      },
      down(props) {
        delete props.outputSchema;
      },
    },
    {
      id: versions.AddIsManuallyResized,
      up(props) {
        props.isManuallyResized = false;
      },
      down(props) {
        delete props.isManuallyResized;
      },
    },
    {
      id: versions.AddColumnStats,
      up(props) {
        props.columnStats = null;
      },
      down(props) {
        delete props.columnStats;
      },
    },
  ],
});
