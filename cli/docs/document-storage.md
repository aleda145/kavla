# Large document storage

Opening reads the ZIP directory, manifest, canvas, and undo state. It registers
upload names without reading their contents and starts the compute worker on
the first compute request. Canvas edits and normal saves do not wait for SQL
execution. Existing table widgets have their own loading and error states.

Starting a canvas worker does not connect configured sources. Browsing tables
connects only that source; SQL connects sources referenced by qualified table
names or native BigQuery/Postgres query functions. Federated joins connect each
referenced source. Unused sources show as disconnected with a Connect action
for table browsing. Spinners appear only during connection, and readiness/errors
are sent to the canvas as connections finish. `kavla connect` also advertises
sources without starting compute or connecting them. Cloud source edits replace
the session lazily, and connection progress is relayed to the cloud canvas.

Each canvas has its own compute worker, created lazily. After its owning editor
disconnects, Kavla saves the canvas and allows 15 seconds for a reconnect before
stopping that worker. Reconnecting or transferring ownership cancels the pending
stop. Other open canvases keep their workers. Upload registrations and query
definitions stay in the parent, so the next query can recreate compute without
reopening the document. Shutdown releases native allocations and cleans the
worker's session databases and spill files; canvas metadata remains cached.
All workers still share the configured compute memory cap. Updating shared
sources replaces sessions lazily, including canvases that are currently inactive.

Uncompressed ZIP entries are read directly through a private loopback HTTP range
server owned by Go. DuckDB uses its HTTP file reader to request Parquet footers,
columns, and row groups. No extracted copy or full-file checksum pass is needed
to open a canvas. HTTP file reading requires DuckDB's httpfs extension (its usual
automatic installation/loading behavior applies). Query setup failures affect
the request, not canvas opening. CSV and JSON can still require scans.

The canvas blob endpoint also serves stored entries directly, including assets.
New uploads are staged under `~/.kavla/working-copies` until written into the
archive. Compressed legacy ZIP entries use bounded disk extraction when that
individual file is accessed. Explicit archive import through the legacy
working-copy API can still stage files. Normal open, save, and history restore
do not extract stored entries. Working directories are removed on normal close.

## Saves and recovery

The portable document remains a version 2 ZIP archive. Versions 1 and 2 remain
readable. Each save appends changed document metadata and new or replaced blobs,
then writes a directory referencing unchanged uploads at their existing offsets.
Every committed revision has one directory entry per filename; ordinary ZIP
readers see the latest revision. ZIP64 supports entries and offsets above 4 GiB.
Unchanged saves append nothing. Save As writes a complete portable archive once,
copying existing ZIP entries directly without extraction.

A `<document>.lock` file serializes archive writers. Before appending, Kavla
durably records the previous committed size in `<document>.journal`. A failed
save or the next open after a crash validates that revision and truncates an
unfinished append back to it. The journal is removed after syncing the completed
archive. Linux/macOS also sync the containing directory. Lock files are retained
to avoid lock-file replacement races. A changed archive length from another
writer is rejected instead of overwriting a stale canvas.

## History and compaction

New history entries are small `.revision` records in `~/.kavla/history`. They
reference a committed prefix of an archive pinned by a hard link in a sibling
`.kavla-history-data` directory. Pins share the same file bytes; each canvas edit
does not duplicate its uploads. The pin stays on the archive's filesystem, so
the history directory can be on another disk. This requires a filesystem with
hard-link support. Preserve the backing directory to retain history.

Kavla never rewrites committed bytes during normal saves. Rename, replacement,
and deletion of the live filename leave pins intact. In-place modification of
archive contents by another application can also modify shared history bytes.
Old standalone history archives still work. Downloading a history revision
streams a complete normal `.kavla` archive, not its internal reference record.
Pruning history removes pins when no retained snapshot uses them.

Old metadata and deleted upload bytes remain in an append-only file. To reclaim
them, close the canvas and run:

```sh
kavla compact /path/to/document.kavla
```

Compaction writes current entries to a new archive and replaces the live file.
It is deliberately explicit because it reads and writes the live uploads once.
History can keep the old inode alive until its snapshots expire. Copy the
`.kavla` file itself when sharing a document; internal history is local.

## Integrity checks

Opening validates archive structure and manifest metadata. New uploads are
hashed while streaming to disk. Direct range reads do not verify a whole-file
SHA-256 checksum before allowing a query. To check every blob's ZIP checksum and
manifest hash without extracting it, run:

```sh
kavla verify /path/to/document.kavla
```

Verification reads all live uploaded files and assets using bounded buffers.
