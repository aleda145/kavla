import { parseTldrawJsonFile, type Editor, type SerializedSchema, type TLRecord, type TLStoreSnapshot } from "tldraw";

type RawRecord = Record<string, unknown> & { id: string; typeName: string };
export type CanvasRecovery = { snapshot: TLStoreSnapshot; warnings: string[] };
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

// Try the normal migration path first. Recovery is deliberately per record:
// one unknown widget must not prevent opening the rest of a document.
export function parseRecoverableCanvas(editor: Editor, json: string): CanvasRecovery {
  const strict = parseTldrawJsonFile({ json, schema: editor.store.schema });
  if (strict.ok) return { snapshot: strict.value.getStoreSnapshot(), warnings: [] };
  const input = JSON.parse(json) as { tldrawFileFormatVersion: number; schema: SerializedSchema; records: unknown[] };
  if (input.tldrawFileFormatVersion !== 1 || !Array.isArray(input.records) || input.schema?.schemaVersion !== 2) {
    throw new Error("This file is not a supported Kavla canvas document.");
  }
  const currentSchema = editor.store.schema.serialize();
  if (currentSchema.schemaVersion !== 2) throw new Error("Unsupported editor schema.");
  const warnings: string[] = [];
  const preserved: unknown[] = [];
  const original = new Map<string, RawRecord>();
  const records = new Map<string, TLRecord>();
  const safeSchema = structuredClone(input.schema);
  for (const [sequence, version] of Object.entries(currentSchema.sequences)) {
    if (typeof safeSchema.sequences[sequence] === "number" && safeSchema.sequences[sequence] > version) {
      safeSchema.sequences[sequence] = version;
      warnings.push(`Recovered newer schema: ${sequence}.`);
    }
  }
  const remember = (record: unknown, reason: string) => {
    preserved.push(record);
    warnings.push(reason);
  };
  const validate = (value: unknown): TLRecord => {
    if (!isObject(value) || typeof value.typeName !== "string") throw new Error("Invalid record.");
    const type = editor.store.schema.types[value.typeName as TLRecord["typeName"]];
    if (!type) throw new Error(`Unknown record type ${value.typeName}.`);
    return type.validate(value) as TLRecord;
  };
  for (const value of input.records) {
    if (!isObject(value) || typeof value.id !== "string" || typeof value.typeName !== "string") {
      remember(value, "Skipped an invalid canvas record.");
      continue;
    }
    const raw = value as RawRecord;
    if (original.has(raw.id)) {
      remember(raw, `Skipped duplicate record ${raw.id}.`);
      continue;
    }
    original.set(raw.id, raw);
    if (raw.typeName === "shape" && (typeof raw.type !== "string" || !editor.hasShapeUtil(raw.type))) {
      remember(raw, `Skipped unsupported shape ${String(raw.type)} (${raw.id}).`);
      continue;
    }
    let candidate: unknown = raw;
    try {
      const migrated = editor.store.schema.migrateStoreSnapshot({
        schema: safeSchema,
        store: { [raw.id]: structuredClone(raw) as unknown as TLRecord },
      });
      if (migrated.type === "success" && migrated.value[raw.id as TLRecord["id"]])
        candidate = migrated.value[raw.id as TLRecord["id"]];
      records.set(raw.id, validate(candidate));
    } catch {
      try {
        // Newer records can still have perfectly valid current fields.
        records.set(raw.id, validate(raw));
        remember(raw, `Kept ${raw.id} using its current fields.`);
      } catch {
        try {
          if (raw.typeName !== "shape" || typeof raw.type !== "string" || !isObject(raw.props))
            throw new Error("Not repairable.");
          const util = editor.getShapeUtil(raw.type);
          const defaults = util.getDefaultProps() as Record<string, unknown>;
          const definition = util.constructor as { props?: Record<string, { validate(value: unknown): unknown }> };
          const allowed = new Set(Object.keys(definition.props ?? defaults));
          const props = {
            ...defaults,
            ...Object.fromEntries(Object.entries(raw.props).filter(([key]) => allowed.has(key))),
          };
          for (const [key, validator] of Object.entries(definition.props ?? {})) {
            try {
              validator.validate(props[key]);
            } catch {
              if (key in defaults) props[key] = defaults[key];
              else delete props[key];
            }
          }
          records.set(raw.id, validate({ ...raw, props }));
          remember(raw, `Repaired properties on ${raw.type} (${raw.id}).`);
        } catch {
          remember(raw, `Skipped incompatible ${String(raw.type ?? raw.typeName)} (${raw.id}).`);
        }
      }
    }
  }
  // Session state is optional; keep only document records and valid cameras.
  for (const [id, record] of records) {
    if (!["document", "page", "shape", "binding", "asset", "camera"].includes(record.typeName)) records.delete(id);
  }
  const fallback = Object.values(editor.store.serialize("document"));
  if (![...records.values()].some((record) => record.typeName === "document")) {
    const document = fallback.find((record) => record.typeName === "document")!;
    records.set(document.id, structuredClone(document));
  }
  if (![...records.values()].some((record) => record.typeName === "page")) {
    const page = fallback.find((record) => record.typeName === "page")!;
    records.set(page.id, structuredClone(page));
    warnings.push("Created a page for recovered shapes.");
  }
  const page = [...records.values()].find((record) => record.typeName === "page")!;
  for (const [id, value] of records) {
    const record = structuredClone(value);
    if (record.typeName === "shape") {
      const ancestors = new Set<string>([id]);
      let parentId: string = record.parentId;
      while (records.get(parentId)?.typeName === "shape") {
        if (ancestors.has(parentId)) {
          parentId = "";
          break;
        }
        ancestors.add(parentId);
        parentId = (records.get(parentId) as typeof record).parentId;
      }
      if (records.get(parentId)?.typeName !== "page") {
        // Preserve the position when an unsupported group/container is omitted.
        let parent = original.get(record.parentId);
        const visited = new Set<string>([id]);
        while (parent?.typeName === "shape" && !visited.has(parent.id)) {
          visited.add(parent.id);
          const angle = typeof parent.rotation === "number" && Number.isFinite(parent.rotation) ? parent.rotation : 0;
          const x = record.x;
          const y = record.y;
          record.x =
            (typeof parent.x === "number" && Number.isFinite(parent.x) ? parent.x : 0) +
            x * Math.cos(angle) -
            y * Math.sin(angle);
          record.y =
            (typeof parent.y === "number" && Number.isFinite(parent.y) ? parent.y : 0) +
            x * Math.sin(angle) +
            y * Math.cos(angle);
          record.rotation += angle;
          parent = original.get(String(parent.parentId));
        }
        record.parentId = page.id as typeof record.parentId;
        remember(original.get(id), `Moved ${id} out of an unavailable container.`);
      }
      const props = record.props as Record<string, unknown>;
      let changed = false;
      for (const key of ["sourceShapeId", "linkedTableId", "assetId"]) {
        if (typeof props[key] === "string" && !records.has(props[key])) {
          props[key] = null;
          changed = true;
        }
      }
      for (const key of ["upstreamShapeIds", "downstreamShapeIds"]) {
        if (Array.isArray(props[key])) {
          const ids = props[key] as unknown[];
          props[key] = ids.filter((entry) => typeof entry === "string" && records.get(entry)?.typeName === "shape");
          changed ||= (props[key] as unknown[]).length !== ids.length;
        }
      }
      if (changed) remember(original.get(id), `Removed unavailable connections from ${id}.`);
    }
    if (
      record.typeName === "binding" &&
      (records.get(record.fromId)?.typeName !== "shape" || records.get(record.toId)?.typeName !== "shape")
    ) {
      records.delete(id);
      remember(original.get(id), `Skipped binding ${id} with a missing endpoint.`);
      continue;
    }
    records.set(id, record);
  }
  const document = [...records.values()].find((record) => record.typeName === "document")!;
  const issues = [...new Set(warnings)];
  if (!issues.length) issues.push("Recovered the canvas using compatible records.");
  document.meta = {
    ...document.meta,
    kavlaImportRecovery: JSON.parse(
      JSON.stringify({ schema: input.schema, records: preserved.filter(Boolean), issues })
    ),
  };
  // Validate the assembled document before replacing anything in the editor.
  const final = parseTldrawJsonFile({
    json: JSON.stringify({ tldrawFileFormatVersion: 1, schema: currentSchema, records: [...records.values()] }),
    schema: editor.store.schema,
  });
  if (!final.ok)
    throw new Error(`Could not assemble a usable canvas (${final.error.type}). The current document was not changed.`);
  return { snapshot: final.value.getStoreSnapshot(), warnings: issues };
}
