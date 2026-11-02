package memoryguard

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const cgroupRoot = "/sys/fs/cgroup"
const sliceName = "kavlacompute.slice"

func enable() (uint64, error) {
	limit, err := memoryBudget()
	if err != nil {
		return 0, fmt.Errorf("determine Kavla memory cap: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// A shared user slice prevents several compute workers each consuming 50%.
	// These units are transient: no root access or persistent system changes.
	properties := []string{
		"2",
		"MemoryMax", "t", strconv.FormatUint(limit, 10),
		"MemorySwapMax", "t", "0",
	}
	args := append([]string{sliceName, "fail"}, properties...)
	args = append(args, "0")
	if err := systemdCall(ctx, "StartTransientUnit", "ssa(sv)a(sa(sv))", args...); err != nil {
		// An existing compute worker may already own the slice. Setting the same
		// properties also handles two processes starting at the same time.
		args = append([]string{sliceName, "true"}, properties...)
		if updateErr := systemdCall(ctx, "SetUnitProperties", "sba(sv)", args...); updateErr != nil {
			return 0, fmt.Errorf("cannot enforce Kavla's memory cap (Linux requires cgroup v2 with a memory controller and a systemd user session): create slice: %v; configure slice: %w", err, updateErr)
		}
	}

	scope := fmt.Sprintf("kavla-duckdb-%d-%d.scope", os.Getpid(), time.Now().UnixNano())
	if err := systemdCall(ctx, "StartTransientUnit", "ssa(sv)a(sa(sv))",
		scope, "fail", "3",
		"Slice", "s", sliceName,
		"PIDs", "au", "1", strconv.Itoa(os.Getpid()),
		"MemoryMax", "t", strconv.FormatUint(limit, 10),
		"0",
	); err != nil {
		return 0, fmt.Errorf("move Kavla into its memory boundary: %w", err)
	}

	// StartTransientUnit queues a job. Check kernel files, not just a successful
	// D-Bus response: systemd may lack permission to enable the memory controller.
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		path, err := currentCgroup()
		if err != nil {
			return 0, err
		}
		if filepath.Base(path) == scope && filepath.Base(filepath.Dir(path)) == sliceName {
			slice := filepath.Dir(path)
			actual, err := readLimit(filepath.Join(slice, "memory.max"))
			if err != nil || actual == 0 || actual > limit {
				return 0, fmt.Errorf("Kavla memory cap was not enforced: memory.max=%d, expected at most %d (read error: %v)", actual, limit, err)
			}
			swap, err := readLimit(filepath.Join(slice, "memory.swap.max"))
			if err != nil || swap != 0 {
				return 0, fmt.Errorf("Kavla swap cap was not enforced: memory.swap.max=%d (read error: %v)", swap, err)
			}
			scopeLimit, err := readLimit(filepath.Join(path, "memory.max"))
			if err != nil || scopeLimit == 0 || scopeLimit > limit {
				return 0, fmt.Errorf("Kavla process memory cap was not enforced: memory.max=%d (read error: %v)", scopeLimit, err)
			}
			return actual, nil
		}
		select {
		case <-ctx.Done():
			return 0, fmt.Errorf("verify Kavla memory boundary: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func memoryBudget() (uint64, error) {
	var info unix.Sysinfo_t
	if err := unix.Sysinfo(&info); err != nil {
		return 0, err
	}
	limit := uint64(info.Totalram) * uint64(info.Unit) / 2
	if limit == 0 {
		return 0, fmt.Errorf("physical memory size is zero")
	}
	path, err := currentCgroup()
	if err != nil {
		return 0, err
	}
	// Do not escape a tighter inherited limit when systemd moves this process
	// into the user slice. Skip our own slice when launched by another Kavla.
	for path != cgroupRoot {
		if filepath.Base(path) == sliceName {
			path = filepath.Dir(path)
			continue
		}
		inherited, err := readLimit(filepath.Join(path, "memory.max"))
		if err != nil {
			return 0, fmt.Errorf("read inherited memory limit: %w", err)
		}
		if inherited < limit {
			limit = inherited
		}
		path = filepath.Dir(path)
	}
	if limit == 0 {
		return 0, fmt.Errorf("inherited memory budget is zero")
	}
	return limit, nil
}

func currentCgroup() (string, error) {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		if path, ok := strings.CutPrefix(line, "0::"); ok {
			if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.Contains(path, "/../") {
				return "", fmt.Errorf("unsupported cgroup path %q", path)
			}
			return filepath.Join(cgroupRoot, path), nil
		}
	}
	return "", fmt.Errorf("cgroup v2 is required for the Linux memory cap")
}

func readLimit(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	value := strings.TrimSpace(string(data))
	if value == "max" {
		return ^uint64(0), nil
	}
	return strconv.ParseUint(value, 10, 64)
}

func systemdCall(ctx context.Context, method, signature string, values ...string) error {
	busctl, err := exec.LookPath("busctl")
	if err != nil {
		// Desktop launchers and agent environments may provide a restricted
		// PATH. Still use the installed system utility when it is available.
		busctl = "/usr/bin/busctl"
		if _, statErr := os.Stat(busctl); statErr != nil {
			return fmt.Errorf("locate systemd busctl: %w", err)
		}
	}
	args := []string{"--user", "--timeout=5s", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", method, signature}
	args = append(args, values...)
	output, err := exec.CommandContext(ctx, busctl, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemd %s: %w: %s", method, err, strings.TrimSpace(string(output)))
	}
	return nil
}
