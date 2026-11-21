package compute

/*
#cgo LDFLAGS: -lpsapi
#include <windows.h>
#include <psapi.h>

static DWORD worker_usage(DWORD pid, SIZE_T *resident, ULONGLONG *cpu) {
	HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
	if (!process) return GetLastError();

	PROCESS_MEMORY_COUNTERS memory;
	FILETIME start, end, kernel, user;
	DWORD err = ERROR_SUCCESS;
	if (GetProcessMemoryInfo(process, &memory, sizeof(memory)) &&
	    GetProcessTimes(process, &start, &end, &kernel, &user)) {
		*resident = memory.WorkingSetSize;
		*cpu = (((ULONGLONG)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime) +
		       (((ULONGLONG)user.dwHighDateTime << 32) | user.dwLowDateTime);
	} else {
		err = GetLastError();
	}
	CloseHandle(process);
	return err;
}
*/
import "C"

import (
	"fmt"
	"syscall"
	"time"
)

func readWorkerUsage(pid int) (uint64, time.Duration, error) {
	var resident C.SIZE_T
	var ticks C.ULONGLONG
	if code := C.worker_usage(C.DWORD(pid), &resident, &ticks); code != 0 {
		return 0, 0, fmt.Errorf("read worker resource usage: %w", syscall.Errno(code))
	}
	return uint64(resident), time.Duration(ticks) * 100 * time.Nanosecond, nil
}
