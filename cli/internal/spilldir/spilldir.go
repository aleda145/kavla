// Package spilldir owns DuckDB's temporary files independently of document data.
// OS locks distinguish active databases from leftovers after a process crash.
package spilldir

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"
)

const directoryPrefix = "session-"

type Directory struct {
	path     string
	owner    *os.File
	once     sync.Once
	closeErr error
}

func rootPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locate DuckDB spill directory: %w", err)
	}
	return filepath.Join(home, ".kavla", "duckdb-tmp"), nil
}

// New cleans abandoned directories and acquires ownership before publishing a
// new one. The registry lock closes the race between creation and ownership.
func New() (_ *Directory, resultErr error) {
	root, err := rootPath()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create DuckDB spill root: %w", err)
	}
	registry, _, err := openLock(filepath.Join(root, ".lock"), true)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, registry.Close()) }()
	if err := cleanupLocked(root); err != nil {
		return nil, err
	}
	path := filepath.Join(root, directoryPrefix+uuid.NewString())
	if err := os.Mkdir(path, 0700); err != nil {
		return nil, fmt.Errorf("create DuckDB spill directory: %w", err)
	}
	owner, acquired, err := openLock(filepath.Join(path, ".owner"), false)
	if err != nil || !acquired {
		if err == nil {
			err = fmt.Errorf("new DuckDB spill directory is already owned")
		}
		return nil, errors.Join(err, os.RemoveAll(path))
	}
	if err := os.Mkdir(filepath.Join(path, "data"), 0700); err != nil {
		return nil, errors.Join(err, owner.Close(), os.RemoveAll(path))
	}
	return &Directory{path: path, owner: owner}, nil
}

// Configure must run before DuckDB imports data or locks its configuration.
func (d *Directory) Configure(db *sql.DB) error {
	path := strings.ReplaceAll(filepath.Join(d.path, "data"), "'", "''")
	if _, err := db.Exec("SET temp_directory = '" + path + "'"); err != nil {
		return fmt.Errorf("configure DuckDB spill directory: %w", err)
	}
	return nil
}

// Close is called only after the database closes. Keep the registry locked while
// releasing ownership and removing files, including on Windows where an open
// lock file cannot be deleted.
func (d *Directory) Close() error {
	d.once.Do(func() {
		registry, _, err := openLock(filepath.Join(filepath.Dir(d.path), ".lock"), true)
		if err != nil {
			d.closeErr = errors.Join(err, d.owner.Close())
			return
		}
		d.closeErr = errors.Join(d.owner.Close(), os.RemoveAll(d.path), registry.Close())
	})
	return d.closeErr
}

// Cleanup is safe while other servers and databases are running. It is also
// called by the parent after a worker exits, including SIGKILL and OOM exits.
func Cleanup() (resultErr error) {
	root, err := rootPath()
	if err != nil {
		return err
	}
	registry, _, err := openLock(filepath.Join(root, ".lock"), true)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, registry.Close()) }()
	return cleanupLocked(root)
}

func cleanupLocked(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("read DuckDB spill directories: %w", err)
	}
	for _, entry := range entries {
		// Ignore unrelated files and symlinks. Only names we generate belong to
		// this cleanup policy; .kavla documents and uploads never live here.
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), directoryPrefix) {
			continue
		}
		id, err := uuid.Parse(strings.TrimPrefix(entry.Name(), directoryPrefix))
		if err != nil || entry.Name() != directoryPrefix+id.String() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		owner, acquired, err := openLock(filepath.Join(path, ".owner"), false)
		if err != nil {
			return err
		}
		if !acquired {
			continue
		}
		// The registry lock prevents another opener racing this deletion after
		// we close the stale owner's file handle.
		if err := errors.Join(owner.Close(), os.RemoveAll(path)); err != nil {
			return fmt.Errorf("remove abandoned DuckDB spill directory: %w", err)
		}
	}
	return nil
}

func openLock(path string, wait bool) (*os.File, bool, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, false, fmt.Errorf("open DuckDB spill lock: %w", err)
	}
	acquired, err := lockFile(file, wait)
	if err != nil || !acquired {
		closeErr := file.Close()
		if err != nil || closeErr != nil {
			return nil, false, fmt.Errorf("lock DuckDB spill directory: %w", errors.Join(err, closeErr))
		}
		return nil, false, nil
	}
	return file, true, nil
}
