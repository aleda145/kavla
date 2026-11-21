package compute

/*
#include <time.h>
#include <sys/types.h>
#include <errno.h>

static int process_cpu_time(pid_t pid, struct timespec *elapsed) {
	clockid_t clock;
	int err = clock_getcpuclockid(pid, &clock);
	if (err != 0) return err;
	return clock_gettime(clock, elapsed) == 0 ? 0 : errno;
}
*/
import "C"

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func readWorkerUsage(pid int) (uint64, time.Duration, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/statm", pid))
	if err != nil {
		return 0, 0, err
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, 0, fmt.Errorf("missing resident page count for worker %d", pid)
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("read worker resident pages: %w", err)
	}
	var cpu C.struct_timespec
	if code := C.process_cpu_time(C.pid_t(pid), &cpu); code != 0 {
		return 0, 0, fmt.Errorf("read worker CPU time: %w", syscall.Errno(code))
	}
	return pages * uint64(os.Getpagesize()), time.Duration(cpu.tv_sec)*time.Second + time.Duration(cpu.tv_nsec), nil
}
