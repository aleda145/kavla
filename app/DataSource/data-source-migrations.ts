import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("data-source", {
  RemoveAutoArrowIds: 1,
  AddColumnStats: 2,
  AddRemoteSourceMetadata: 3,
});

export const DataSourceMigrations = createShapePropsMigrationSequence({
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
      id: versions.AddColumnStats,
      up(props) {
        props.columnStats = null;
      },
      down(props) {
        delete props.columnStats;
      },
    },
    {
      id: versions.AddRemoteSourceMetadata,
      up(props) {
        props.sourceName = null;
        props.sourceType = null;
        props.remoteTableRef = null;
      },
      down(props) {
        delete props.sourceName;
        delete props.sourceType;
        delete props.remoteTableRef;
      },
    },
  ],
});
