import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTLSchema, defaultShapeSchemas, type SerializedSchema, type TLShape } from "tldraw";
import { ChartShapeProps } from "../chart-shape-props.ts";
import { ChartShapeMigrations } from "../chart-shape-migrations.ts";

test("existing demo archive charts migrate and validate without prototype metadata", () => {
  const path = fileURLToPath(new URL("../../../cli/internal/demo/titanic.kavla", import.meta.url));
  const archive = JSON.parse(
    execFileSync(
      "python3",
      ["-c", "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('canvas.json').decode())", path],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    )
  ) as {
    schema: SerializedSchema;
    records: TLShape[];
  };
  const schema = createTLSchema({
    shapes: { ...defaultShapeSchemas, "chart-shape": { props: ChartShapeProps, migrations: ChartShapeMigrations } },
  });
  const charts = archive.records.filter((r) => r.typeName === "shape" && r.type === "chart-shape");
  assert.ok(charts.length > 0, "archive contains old charts");
  for (const chart of charts) {
    const migrated = schema.migratePersistedRecord(chart, archive.schema);
    assert.equal(migrated.type, "success");
    if (migrated.type !== "success") throw new Error("Chart migration failed");
    const record = schema.types.shape.validate(migrated.value as TLShape) as TLShape;
    assert.equal(record.meta.nativeVisualization, undefined);
    const prototype = {
      ...record,
      meta: { ...record.meta, nativeVisualization: true, nativeSelection: "saved analytical definition" },
    };
    const restored = schema.types.shape.validate(JSON.parse(JSON.stringify(prototype))) as TLShape;
    assert.deepEqual(restored.props, record.props);
  }
});
