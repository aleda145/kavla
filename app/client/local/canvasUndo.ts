import type { Editor, RecordsDiff, TLHistoryEntry, TLRecord } from "tldraw";

type HistoryEntry = TLHistoryEntry<TLRecord>;
type SavedUndo = { version: 1; undos: HistoryEntry[]; redos: HistoryEntry[] };
const MAX_PERSISTED_UNDO_BYTES = 3 * 1024 * 1024;
const MAX_PERSISTED_UNDO_ENTRIES = 100;
type HistoryStack = {
  length: number;
  head: HistoryEntry | null;
  tail: HistoryStack;
  push(entry: HistoryEntry): HistoryStack;
};
type HistoryStacks = { undos: HistoryStack; redos: HistoryStack };

// tldraw has no history import/export API. Keep the private stack access here so
// a tldraw upgrade only has one place to update.
function historyStacks(editor: Editor): { get(): HistoryStacks; set(stacks: HistoryStacks): void } {
  return (editor as unknown as { history: { stacks: { get(): HistoryStacks; set(stacks: HistoryStacks): void } } })
    .history.stacks;
}

function recentEntries(stack: HistoryStack): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  while (stack.head && entries.length < MAX_PERSISTED_UNDO_ENTRIES) {
    entries.push(stack.head);
    stack = stack.tail;
  }
  return entries;
}

function documentDiff(editor: Editor, diff: RecordsDiff<TLRecord>): RecordsDiff<TLRecord> {
  const documentTypes = editor.store.scopedTypes.document;
  return {
    added: Object.fromEntries(Object.entries(diff.added).filter(([, record]) => documentTypes.has(record.typeName))),
    updated: Object.fromEntries(
      Object.entries(diff.updated).filter(([, records]) => documentTypes.has(records[1].typeName))
    ),
    removed: Object.fromEntries(
      Object.entries(diff.removed).filter(([, record]) => documentTypes.has(record.typeName))
    ),
  } as RecordsDiff<TLRecord>;
}

function documentEntries(editor: Editor, entries: HistoryEntry[]): HistoryEntry[] {
  const result: HistoryEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "stop") {
      result.push(entry);
      continue;
    }
    const diff = documentDiff(editor, entry.diff);
    if (Object.keys(diff.added).length || Object.keys(diff.updated).length || Object.keys(diff.removed).length) {
      result.push({ type: "diff", diff });
    }
  }
  return result;
}

export function serializeCanvasUndo(
  editor: Editor,
  blockedShapeIds: ReadonlySet<string> = new Set(),
  blockedAssetIds: ReadonlySet<string> = new Set()
): SavedUndo {
  const stacks = historyStacks(editor).get();
  const pendingDiff = (
    editor as unknown as {
      history: {
        pendingDiff: { debug(): { diff: RecordsDiff<TLRecord>; isEmpty: boolean } };
      };
    }
  ).history.pendingDiff.debug();
  const pending = pendingDiff.isEmpty ? [] : [{ type: "diff" as const, diff: pendingDiff.diff }];
  const undo: SavedUndo = {
    version: 1,
    undos: [],
    redos: [],
  };
  let bytes = 0;
  let entries = 0;
  for (const [key, source] of [
    ["undos", documentEntries(editor, [...pending, ...recentEntries(stacks.undos)])],
    ["redos", documentEntries(editor, recentEntries(stacks.redos))],
  ] as const) {
    for (const entry of source) {
      if (entry.type === "diff") {
        const records = [
          ...Object.values(entry.diff.added),
          ...Object.values(entry.diff.removed),
          ...Object.values(entry.diff.updated).flat(),
        ];
        if (
          records.some(
            (record) =>
              blockedShapeIds.has(record.id) ||
              blockedAssetIds.has(record.id) ||
              (record.typeName === "shape" &&
                "assetId" in record.props &&
                typeof record.props.assetId === "string" &&
                blockedAssetIds.has(record.props.assetId))
          )
        )
          break;
      }
      const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      if (entries >= MAX_PERSISTED_UNDO_ENTRIES || bytes + size > MAX_PERSISTED_UNDO_BYTES) break;
      undo[key].push(entry);
      bytes += size;
      entries += 1;
    }
  }
  return undo;
}

function validDiff(editor: Editor, value: unknown): value is RecordsDiff<TLRecord> {
  if (!value || typeof value !== "object") return false;
  const diff = value as Record<string, unknown>;
  for (const field of ["added", "updated", "removed"] as const) {
    if (!diff[field] || typeof diff[field] !== "object" || Array.isArray(diff[field])) return false;
    for (const [id, raw] of Object.entries(diff[field])) {
      const records = field === "updated" ? raw : [raw];
      if (!Array.isArray(records) || (field === "updated" && records.length !== 2)) return false;
      for (const record of records) {
        if (!record || typeof record !== "object") return false;
        const candidate = record as TLRecord;
        if (candidate.id !== id || !editor.store.scopedTypes.document.has(candidate.typeName)) return false;
        try {
          editor.store.schema.types[candidate.typeName].validate(candidate);
        } catch {
          return false;
        }
      }
    }
  }
  return true;
}

function validEntries(editor: Editor, value: unknown): value is HistoryEntry[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.type === "stop") return typeof entry.id === "string";
      return entry.type === "diff" && validDiff(editor, entry.diff);
    })
  );
}

export function restoreCanvasUndo(editor: Editor, undoJson: string | null): void {
  if (!undoJson) return;
  const parsed = JSON.parse(undoJson) as { kavlaUndo?: unknown };
  if ("tldrawFileFormatVersion" in parsed && parsed.kavlaUndo === undefined) return;
  const saved = parsed.kavlaUndo ?? parsed;
  if (!saved || typeof saved !== "object") throw new Error("The saved canvas undo history is invalid.");
  const undo = saved as Record<string, unknown>;
  if (undo.version !== 1 || !validEntries(editor, undo.undos) || !validEntries(editor, undo.redos)) {
    throw new Error("The saved canvas undo history is incompatible with this version of Kavla.");
  }
  const manager = historyStacks(editor);
  const empty = manager.get();
  let undos = empty.undos;
  let redos = empty.redos;
  for (const entry of [...undo.undos].reverse()) undos = undos.push(entry);
  for (const entry of [...undo.redos].reverse()) redos = redos.push(entry);
  manager.set({ undos, redos });
}
