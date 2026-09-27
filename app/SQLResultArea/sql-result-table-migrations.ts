import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("sql-result-table", {
  RemoveAutoArrowIds: 1,
  AddColumnSizing: 2,
  RemoveDuplicateSourceState: 3,
  AddIsManuallyResized: 4,
});

export const SQLResultTableMigrations = createShapePropsMigrationSequence({
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
      id: versions.AddColumnSizing,
      up(props) {
        props.columnSizing = {};
      },
      down(props) {
        delete props.columnSizing;
      },
    },
    {
      id: versions.RemoveDuplicateSourceState,
      up(props) {
        delete props.name;
      },
      down(props) {
        props.name = "result";
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
  ],
});
