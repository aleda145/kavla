//go:build linux || darwin

package localapp

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func lockArchiveFile(file *os.File, wait bool) (bool, error) {
	flags := unix.LOCK_EX
	if !wait {
		flags |= unix.LOCK_NB
	}
	for {
		err := unix.Flock(int(file.Fd()), flags)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if !wait && (errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN)) {
			return false, nil
		}
		return err == nil, err
	}
}

func syncArchiveDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
