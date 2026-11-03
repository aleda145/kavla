package localapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

// History pins the immutable prefix of an append-only archive. Keep the link on
// the archive's filesystem, so snapshots do not copy uploads across devices.
// Compaction replaces the live inode; existing history continues using its pin.
func (d *Document) pinArchiveSnapshot(sourcePath, destinationPath string) error {
	reader, err := openDocumentArchive(sourcePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	info, err := reader.file.Stat()
	if err != nil {
		return err
	}
	directory := filepath.Join(filepath.Dir(reader.file.Name()), ".kavla-history-data")
	if filepath.Base(filepath.Dir(reader.file.Name())) == ".kavla-history-data" {
		directory = filepath.Dir(reader.file.Name())
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	backing := ""
	for _, entry := range files {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".kavla") {
			continue
		}
		candidate, err := entry.Info()
		if err != nil {
			return err
		}
		if os.SameFile(info, candidate) {
			backing = filepath.Join(directory, entry.Name())
			break
		}
	}
	created := false
	if backing == "" {
		backing = filepath.Join(directory, uuid.NewString()+".kavla")
		if err := os.Link(reader.file.Name(), backing); err != nil {
			return fmt.Errorf("pin history archive (filesystem must support hard links): %w", err)
		}
		created = true
		if err := syncArchiveDirectory(directory); err != nil {
			return err
		}
	}
	data, err := json.Marshal(archiveReference{Path: backing, Size: reader.size})
	if err == nil {
		err = atomicWriteFile(destinationPath, append([]byte(historyReferenceMagic), data...), 0600)
	}
	if err != nil && created {
		return errors.Join(err, os.Remove(backing))
	}
	return err
}

// A downloadable history revision is a real ZIP, not its small internal
// reference file. Streaming its committed prefix preserves the portable format.
func snapshotContent(path string) (*documentArchive, io.ReadSeeker, error) {
	reader, err := openDocumentArchive(path)
	if err != nil {
		return nil, nil, err
	}
	return reader, io.NewSectionReader(reader.file, 0, reader.size), nil
}

func removeUnusedHistoryPins(directory string, candidates map[string]bool) error {
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range files {
		ext := filepath.Ext(entry.Name())
		if (ext != ".kavla" && ext != ".revision") || !snapshotIDPattern.MatchString(strings.TrimSuffix(entry.Name(), ext)) {
			continue
		}
		ref, err := readHistoryReference(filepath.Join(directory, entry.Name()))
		if err != nil {
			return err
		}
		if ref != nil {
			delete(candidates, ref.Path)
		}
	}
	for path := range candidates {
		if filepath.Base(filepath.Dir(path)) != ".kavla-history-data" {
			return fmt.Errorf("invalid history backing path")
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
