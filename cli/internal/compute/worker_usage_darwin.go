package compute

/*
#cgo LDFLAGS: -lproc
#include <libproc.h>
#include <mach/mach_time.h>
*/
import "C"

import (
	"fmt"
	"time"
	"unsafe"
)

func readWorkerUsage(pid int) (uint64, time.Duration, error) {
	var info C.struct_proc_taskinfo
	n, err := C.proc_pidinfo(C.int(pid), C.PROC_PIDTASKINFO, 0, unsafe.Pointer(&info), C.sizeof_struct_proc_taskinfo)
	if n != C.sizeof_struct_proc_taskinfo {
		return 0, 0, fmt.Errorf("read worker resource usage for PID %d (got %d bytes): %v", pid, n, err)
	}
	var scale C.mach_timebase_info_data_t
	if code := C.mach_timebase_info(&scale); code != 0 {
		return 0, 0, fmt.Errorf("read Mach clock timebase: %d", code)
	}
	ticks := info.pti_total_user + info.pti_total_system
	nanos := float64(ticks) * float64(scale.numer) / float64(scale.denom)
	return uint64(info.pti_resident_size), time.Duration(nanos), nil
}
