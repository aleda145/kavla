# Memory limits

On Linux, `kavla run`, `kavla open`, and `kavla connect` install a kernel-enforced
memory boundary before opening documents or initializing DuckDB. The Go CLI
manages this through the systemd user manager using `busctl`; no manual setup of
units or root access is required on a supported desktop.

The shared transient `kavla.slice` has a `MemoryMax` of 50% of physical RAM and
`MemorySwapMax=0`. Multiple Kavla servers for the same user share this budget,
including their newly launched child processes. Tighter inherited cgroup memory
limits are retained in each server's scope. Independently launched applications
and an already-running external browser are outside this boundary.

Kavla checks the actual cgroup v2 `memory.max` and `memory.swap.max` files before
continuing. Linux startup fails if systemd, the user bus, `busctl`, the delegated
memory controller, or swap enforcement is unavailable. It never silently falls
back to an unenforced Linux session. Units are runtime-only and do not modify
system configuration files.

DuckDB also receives a cooperative memory limit of half the enforced budget
(normally 25% of physical RAM) before its configuration is locked. This leaves
headroom for allocations outside DuckDB's buffer manager, Go, Arrow, and desktop
processes. It is a per-engine setting, not a separate allowance for each engine:
the shared kernel boundary still applies to their combined consumption.

The hard limit is a last resort. Linux can kill a process within the group when
it cannot reclaim enough memory. Because DuckDB currently runs inside the Go
server, this can terminate that server and lose unsaved edits; it is not a
recoverable query error. Moving compute into a supervised child process is
required to keep the server alive after a native out-of-memory failure.

The cap does not reserve the other half of RAM, and other applications can still
exhaust the machine. Kernel accounting may briefly exceed the boundary. A cap
also does not eliminate CPU or disk contention. No `.kavla` format changes are
made by this feature.

The platform boundary is `internal/memoryguard`. macOS and Windows currently
preserve existing startup behavior and print that hard enforcement is Linux-only.
They need native implementations; Go's `debug.SetMemoryLimit` excludes native
DuckDB allocations and cannot replace OS enforcement.
