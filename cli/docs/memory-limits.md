# Memory limits

Each document session runs DuckDB in a separate, supervised compute process.
The canvas HTTP server, document saves, agent orchestration, and desktop browser
stay in the parent process. When limits are configured on supported Linux
desktops, only workers enter the compute memory boundary. A configured Docker
memory boundary includes the parent too.
This also applies to sessions used by `kavla connect`.

Canvas workers start on demand. Once an editor disconnects, its worker stops
after a 15-second grace period unless another editor acquires that canvas.
Stopping releases native memory and removes the worker's temporary databases
and spill files. The next compute request restores uploads and query definitions
lazily. Workers for canvases that remain open continue running, sharing the same
cap when compute enforcement is active; cached canvas metadata in the parent is
outside that compute-only cap.

By default Kavla does not install a compute memory cap or override DuckDB's
automatic memory budget. There is no default Docker RAM or swap cap either.
Existing OS and container limits still apply. DuckDB retains its normal memory
management, whose buffer manager defaults to approximately 80% of available RAM;
see [DuckDB's limits](https://duckdb.org/docs/current/operations_manual/limits).
This replaces Kavla's previous automatic 50% compute cap and 25% DuckDB budget.

To opt into Kavla's limits, configure `~/.kavla/config.yaml`, for example:

```yaml
memory:
  enforcement: auto
  limit_percent: 50
  duckdb_percent_of_limit: 50
  swap_limit_mib: 0
```

These are the defaults for omitted values **after opting in**. Setting any of
`limit_percent`, `duckdb_percent_of_limit`, or `swap_limit_mib` opts in, preserving
existing partial configurations. Setting `enforcement: required` also explicitly
requests a cap, using these values unless overridden. An absent or empty memory
section, or `enforcement: auto` or `off` alone, adds no limits. Remove the numeric
memory settings (and `required`, if present) to return to automatic sizing.
`limit_percent` is the compute budget as a percentage of available RAM (1–100):
physical RAM, reduced to the tightest visible inherited cgroup v2 memory limit.
It is a shared hard cap only when compute enforcement succeeds.
`duckdb_percent_of_limit` is each DuckDB engine's share of that budget (1–99), not
a percentage of total RAM. The defaults therefore give DuckDB 25% of available
RAM and, when enforcement succeeds, compute workers a shared 50% hard cap.
For example, `limit_percent: 60` with `duckdb_percent_of_limit: 70` gives each
engine a 42% available RAM budget. Keep headroom for allocations outside
DuckDB's buffer manager.

`swap_limit_mib` is the shared OS swap allowance in MiB (a non-negative integer);
0 disables swap for compute when enforcement is active. For example, 1024 allows
up to 1 GiB of swap in addition to the RAM cap. This does not control DuckDB's own
spill files.
Invalid values and unknown memory keys are rejected. `kavla config view` displays
the effective settings without exposing credentials.

`enforcement` controls what happens when the compute-only boundary is unavailable:

- `auto` (default): when a limit is configured, try to install and verify the hard boundary. On failure,
  log the reason and continue with a separate worker and a cooperative DuckDB
  memory budget. Existing container limits remain in effect.
- `required`: fail compute startup unless a compute-only hard boundary is
  verified. Use this when availability must not override enforcement.
- `off`: skip installing the compute boundary. Keep the worker process and its
  cooperative DuckDB budget. This does not remove Docker or host limits.

The environment variable `KAVLA_MEMORY_ENFORCEMENT=auto|required|off` overrides
the YAML setting. For example, `KAVLA_MEMORY_ENFORCEMENT=off kavla run` is the
escape hatch if systemd or cgroup setup is broken. Invalid configuration is
still an error; this does not hide query, file, or worker launch failures.
If a configured limit requires Linux memory discovery and discovery fails, the fallback uses a conservative
256 MiB compute budget (128 MiB per DuckDB engine with default settings), reduced
further if a smaller inherited budget was discovered, and logs the discovery
error. This is a cooperative budget, not a kernel guarantee.

Workers read these settings when they start, including replacements after a
crash. Restart all Kavla instances after editing so every worker uses the same
settings. With enforcement active, starting a worker updates the shared kernel
limits for existing workers too; their internal DuckDB budgets stay unchanged
until restart.

On Linux, the worker installs its kernel-enforced boundary before initializing
DuckDB. Go manages this through the systemd user manager using `busctl`; no
manual unit setup or root access is required on a supported desktop. The shared
transient `kavlacompute.slice` uses the configured RAM and swap limits (after opting in,
`MemoryMax` is 50% of available RAM and `MemorySwapMax=0`). All compute workers for
the same user share this budget.
Tighter inherited cgroup limits are retained in each worker's scope.

The worker checks the actual cgroup v2 `memory.max` and `memory.swap.max` files
before claiming enforcement. If systemd, the user bus, `busctl`, the delegated
memory controller, or swap enforcement is unavailable, `auto` logs a warning
and continues; `required` fails with instructions for the escape hatch.
Units are runtime-only and do not modify system configuration files.

## Docker

The shipped image runs Kavla directly as an unprivileged user. It has no systemd
user manager or user D-Bus session; installing `busctl` alone would not provide
either. Normal Docker containers also do not delegate a writable cgroup subtree
to the application. Kavla starts without systemd by default. If Kavla limits are
explicitly configured, `auto` uses the fallback in this image. Docker enforces
any configured outer memory boundary. No privileged container, host
D-Bus mount, or writable host cgroup mount is needed.

The repository's `compose.yaml` defaults both memory settings to zero, which
leaves Docker RAM and swap limits unset. To set a limit explicitly, run
`KAVLA_DOCKER_MEMORY=4g docker compose up -d`. This sets a 4 GiB container RAM
limit and disables swap by setting `memswap_limit` equal to `mem_limit`.
Compose also passes through
`KAVLA_MEMORY_ENFORCEMENT` when set; otherwise the YAML setting applies, defaulting
to `auto`. With `docker run`, omit memory flags for no Docker cap:

```sh
docker run --init --rm \
  -p 40743:40743 -v kavla-data:/data \
  aleda145/kavla:latest
```

Add, for example, `--memory=4g --memory-swap=4g` to opt into a container cap.
Use an image containing these changes. Docker's `--memory-swap` is RAM plus swap,
so matching it to `--memory` disables swap; setting it to zero does not.
See [Docker's resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).
Kavla's `swap_limit_mib` does not configure Docker; the Docker runtime owns that
limit. A Docker limit alone does not opt into Kavla's additional percentage
budgets; DuckDB keeps its automatic sizing. If the example YAML above is also
configured, a 2 GiB container gives each DuckDB engine a 512 MiB cooperative
budget. Discovery for explicitly configured budgets includes `/sys/fs/cgroup/memory.max`
when the container's cgroup namespace reports `0::/`, as well as visible ancestor
limits. This requires cgroup v2 for automatic sizing; older cgroup v1 setups use
the conservative discovery fallback and should still set Docker's outer limits.

Docker's cap covers the server, all compute workers, and other processes in the
container. An OOM can kill the server or stop the whole container; desktop-style
server survival is not guaranteed. Multiple workers can exceed the cooperative
budget in aggregate. Logs distinguish inherited limits from a verified
compute-only cap. A compute-only hard boundary in Docker would require a
properly delegated cgroup subtree or running compute in a separate container;
the shipped single-container setup does not provide that boundary.

## Worker behavior

When Kavla limits are configured, DuckDB receives its share of the compute budget (by default,
half, normally 25% of available RAM) before its configuration is locked. This leaves
headroom for allocations outside DuckDB's buffer manager, Go, and Arrow in the
worker. It is a per-engine setting, not a separate allowance for each engine:
the shared kernel boundary, when active, applies to their combined consumption.

The compute-only hard limit is a last resort. Linux can kill a worker when it
cannot reclaim enough memory. Its current request fails while the canvas and document server
stay alive. On the next compute request, the parent starts a replacement and
restores successful uploads, mounted sources, and query views. It does not
automatically retry the operation that failed. Recovery registers views over the
uploaded originals again without copying their rows into DuckDB tables.
Arbitrary SQL side effects are not replayed.

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

Uploaded originals remain bundled in the `.kavla` archive. DuckDB queries stored
entries directly through a private Go HTTP range server and lazy views with the
same `uploaded_files.main.<table>` names. New uploads and compressed legacy
entries use `~/.kavla/working-copies`, avoiding RAM-backed system temporary
directories. Parquet scans can read
only the required columns and row groups; CSV and JSON queries may need to scan
the files again. Upload views are read-only. Existing archives remain compatible
and do not need a format migration. Normal document teardown removes its working
copy after saving; copies retained after a crash or failed save are not swept by
DuckDB cleanup, since they may contain unsaved document data. See
[document storage](document-storage.md) for incremental saves, history, recovery,
compaction, and integrity verification.

DuckDB's main and upload catalogs are also files under
`~/.kavla/duckdb-tmp/session-<unique-id>`. The main file is named `memory.duckdb`
only to preserve the existing default SQL catalog name; it is disk-backed.
These disposable catalogs are rebuilt from document metadata on worker restart,
not bundled as additional copies of the data. Disk-backed storage still uses
RAM for caching and query execution, so the memory limits remain necessary.

DuckDB spills under `~/.kavla/duckdb-tmp/session-<unique-id>/data`, including the
short-lived databases used to inspect configured sources. Each instance holds an
OS lock for its directory. Startup removes abandoned directories while leaving
live instances alone, including those belonging to other Kavla servers. Closing
a database removes its directory; the parent also removes abandoned spill files
after a worker exits or is killed. If the entire app is forcibly killed, the next
startup performs the cleanup. The shared `.lock` file is retained for coordination.
Old `.tmp` directories from previous versions in working directories are not
automatically removed, as they may still be in use by an older running instance.

An explicitly configured cap does not reserve the remaining RAM, and other applications can still
exhaust the machine. Kernel accounting may briefly exceed the boundary. A cap
also does not eliminate CPU or disk contention. No `.kavla` format changes are
made by this feature.

The process boundary is `internal/compute`; OS enforcement is in
`internal/memoryguard`. macOS and Windows use separate workers but report that
hard enforcement is unavailable when requested, retaining DuckDB's default memory budget.
`required` also fails on these platforms. They need native limit implementations; Go's
`debug.SetMemoryLimit` excludes native DuckDB allocations and cannot replace OS
enforcement. Existing running versions must be restarted to use the new boundary.
