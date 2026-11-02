//go:build linux || darwin

package spilldir

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func lockFile(file *os.File, wait bool) (bool, error) {
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
