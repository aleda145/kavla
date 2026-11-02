# Memory limits

Each document session runs DuckDB in a separate, supervised compute process.
The canvas HTTP server, document saves, agent orchestration, and desktop browser
stay in the parent process, outside the compute memory boundary. This also
applies to sessions used by `kavla connect`.

On Linux, the worker installs its kernel-enforced boundary before initializing
DuckDB. Go manages this through the systemd user manager using `busctl`; no
manual unit setup or root access is required on a supported desktop. The shared
transient `kavlacompute.slice` has a `MemoryMax` of 50% of physical RAM and
`MemorySwapMax=0`. All compute workers for the same user share this budget.
Tighter inherited cgroup limits are retained in each worker's scope.

The worker checks the actual cgroup v2 `memory.max` and `memory.swap.max` files
before continuing. Compute startup fails if systemd, the user bus, `busctl`, the delegated
memory controller, or swap enforcement is unavailable. It never silently falls
back to an unenforced Linux session. Units are runtime-only and do not modify
system configuration files.

DuckDB also receives a cooperative memory limit of half the enforced budget
(normally 25% of physical RAM) before its configuration is locked. This leaves
headroom for allocations outside DuckDB's buffer manager, Go, and Arrow in the
worker. It is a per-engine setting, not a separate allowance for each engine:
the shared kernel boundary still applies to their combined consumption.

The hard limit is a last resort. Linux can kill a worker when it cannot reclaim
enough memory. Its current request fails while the canvas and document server
stay alive. On the next compute request, the parent starts a replacement and
restores successful uploads, mounted sources, and query views. It does not
automatically retry the operation that failed. Recovery re-imports uploaded
files, which can take time for large documents and can fail again if they exceed
the budget. Arbitrary SQL side effects are not replayed.

Workers communicate through an authenticated loopback HTTP connection. The
per-worker token and source configuration are passed through a private stdin
pipe, not command-line arguments. Closing the pipe when the parent exits stops
the worker. Closing a session waits for graceful exit, then kills a stuck worker.
Cancelling an interrupted request discards the worker so native work cannot
continue after the parent rolls back a file operation.

Arrow results cross the boundary in batches, and interrupted streams are errors
rather than successful partial results. Individual result values/rows above
8 MiB are rejected for transfer; full file exports remain available. The parent
and browser still allocate memory for results they consume: this change bounds
compute memory, not all possible canvas or browser memory use.

DuckDB spills under `~/.kavla/duckdb-tmp/session-<unique-id>/data`, including the
short-lived databases used to inspect configured sources. Each instance holds an
OS lock for its directory. Startup removes abandoned directories while leaving
live instances alone, including those belonging to other Kavla servers. Closing
a database removes its directory; the parent also removes abandoned spill files
after a worker exits or is killed. If the entire app is forcibly killed, the next
startup performs the cleanup. The shared `.lock` file is retained for coordination.
Old `.tmp` directories from previous versions in working directories are not
automatically removed, as they may still be in use by an older running instance.

The cap does not reserve the other half of RAM, and other applications can still
exhaust the machine. Kernel accounting may briefly exceed the boundary. A cap
also does not eliminate CPU or disk contention. No `.kavla` format changes are
made by this feature.

The process boundary is `internal/compute`; OS enforcement is in
`internal/memoryguard`. macOS and Windows use separate workers but report that
hard enforcement is Linux-only. They need native limit implementations; Go's
`debug.SetMemoryLimit` excludes native DuckDB allocations and cannot replace OS
enforcement. Existing running versions must be restarted to use the new boundary.
