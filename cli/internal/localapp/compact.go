package localapp

import "os"

// CompactDocument rewrites the live archive once, retaining only current
// entries. History keeps its pinned revisions until those snapshots expire.
func CompactDocument(path string) (int64, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	document, err := openDocument(path, false)
	if err != nil {
		return 0, 0, err
	}
	defer document.CleanupWorkingCopy()
	document.mu.Lock()
	document.rewriteArchive = true
	err = document.writeArchiveWithHistoryLocked(document.path, true, "restore")
	document.mu.Unlock()
	if err != nil {
		return info.Size(), 0, err
	}
	compacted, err := os.Stat(path)
	if err != nil {
		return info.Size(), 0, err
	}
	return info.Size(), compacted.Size(), nil
}
