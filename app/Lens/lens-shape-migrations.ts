import { createShapePropsMigrationIds, createShapePropsMigrationSequence } from "tldraw";

const versions = createShapePropsMigrationIds("lens-shape", {
  Init: 1,
  GenerationStatus: 2,
});

export const LensShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: versions.Init,
      up(props) {
        props.sourceShapeId = props.sourceShapeId ?? null;
        props.prompt = props.prompt ?? "";
        props.dataSql = props.dataSql ?? null;
        props.code = props.code ?? "";
        props.title = props.title ?? props.name ?? "Lens";
        props.description = props.description ?? null;
        props.jobId = props.jobId ?? null;
        props.generatedAt = props.generatedAt ?? null;
        props.error = props.error ?? null;
        props.retryCount = props.retryCount ?? 0;
        props.generationStatus = props.generationStatus ?? "ready";
        props.w = props.w ?? 720;
        props.h = props.h ?? 480;
        props.name = props.name ?? props.title ?? "Lens";
      },
      down(_props) {},
    },
    {
      id: versions.GenerationStatus,
      up(props) {
        props.generationStatus = props.generationStatus ?? "ready";
      },
      down(props) {
        delete props.generationStatus;
      },
    },
  ],
});
