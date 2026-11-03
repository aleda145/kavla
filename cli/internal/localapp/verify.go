package localapp

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
)

// VerifyDocument explicitly reads every blob and checks ZIP CRCs and manifest
// hashes without extracting files or allocating memory proportional to size.
func VerifyDocument(path string) (int, error) {
	document, err := openDocument(path, false)
	if err != nil {
		return 0, err
	}
	defer document.CleanupWorkingCopy()
	archive, entries, err := openArchiveEntries(document.archivePath)
	if err != nil {
		return 0, err
	}
	defer archive.Close()
	verified := 0
	for _, blob := range document.manifest.Blobs {
		reader, err := entries["blobs/"+blob.ID].Open()
		if err != nil {
			return verified, err
		}
		hash := sha256.New()
		size, err := io.Copy(hash, reader)
		closeErr := reader.Close()
		if err != nil {
			return verified, fmt.Errorf("verify %s: %w", blob.FileName, err)
		}
		if closeErr != nil {
			return verified, closeErr
		}
		if size != blob.Size || hex.EncodeToString(hash.Sum(nil)) != blob.SHA256 {
			return verified, fmt.Errorf("checksum mismatch for %s", blob.FileName)
		}
		verified++
	}
	return verified, nil
}
