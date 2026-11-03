package localapp

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func lockArchiveFile(file *os.File, wait bool) (bool, error) {
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK)
	if !wait {
		flags |= windows.LOCKFILE_FAIL_IMMEDIATELY
	}
	err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &windows.Overlapped{})
	if !wait && errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}

func syncArchiveDirectory(_ string) error { return nil }
