package localapp

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Every committed revision is a normal ZIP (including ZIP64). An update appends
// local entries and a new directory referencing unchanged entries at their old
// offsets. Earlier committed prefixes remain readable by history readers.
// A durable journal records the previous length before we touch the archive.
type archiveJournal struct {
	Size int64 `json:"size"`
}

func acquireArchiveLock(path string) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	locked, err := lockArchiveFile(f, false)
	if err != nil || !locked {
		f.Close()
		if err == nil {
			err = fmt.Errorf("document is being saved by another Kavla process")
		}
		return nil, err
	}
	return func() { _ = f.Close() }, nil
}

func recoverArchive(path string) error {
	data, err := os.ReadFile(path + ".journal")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal archiveJournal
	if err := json.Unmarshal(data, &journal); err != nil || journal.Size < 22 {
		return fmt.Errorf("invalid save recovery journal for %s", path)
	}
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() < journal.Size {
		return fmt.Errorf("archive is shorter than its saved revision")
	}
	// Verify the old commit before truncating any interrupted append.
	if _, err := zip.NewReader(io.NewSectionReader(f, 0, journal.Size), journal.Size); err != nil {
		return fmt.Errorf("cannot recover previous archive revision: %w", err)
	}
	if err := f.Truncate(journal.Size); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := os.Remove(path + ".journal"); err != nil {
		return err
	}
	return syncArchiveDirectory(filepath.Dir(path))
}

// Read the original directory records verbatim, retaining ZIP64 offsets and
// extension fields. The allocation is bounded independently of upload sizes.
func archiveDirectory(file *os.File, size int64) (map[string][]byte, error) {
	tailSize := min(size, int64(65557))
	tail := make([]byte, tailSize)
	if _, err := file.ReadAt(tail, size-tailSize); err != nil {
		return nil, err
	}
	end := -1
	for i := len(tail) - 22; i >= 0; i-- {
		if binary.LittleEndian.Uint32(tail[i:]) == 0x06054b50 && i+22+int(binary.LittleEndian.Uint16(tail[i+20:])) == len(tail) {
			end = i
			break
		}
	}
	if end < 0 {
		return nil, fmt.Errorf("missing ZIP directory")
	}
	directorySize := uint64(binary.LittleEndian.Uint32(tail[end+12:]))
	directoryOffset := uint64(binary.LittleEndian.Uint32(tail[end+16:]))
	if directorySize == 0xffffffff || directoryOffset == 0xffffffff || binary.LittleEndian.Uint16(tail[end+10:]) == 0xffff {
		locator := make([]byte, 20)
		if _, err := file.ReadAt(locator, size-tailSize+int64(end)-20); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(locator) != 0x07064b50 {
			return nil, fmt.Errorf("missing ZIP64 locator")
		}
		record := make([]byte, 56)
		offset := binary.LittleEndian.Uint64(locator[8:])
		if offset > uint64(size)-56 {
			return nil, fmt.Errorf("invalid ZIP64 offset")
		}
		if _, err := file.ReadAt(record, int64(offset)); err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(record) != 0x06064b50 {
			return nil, fmt.Errorf("invalid ZIP64 directory")
		}
		directorySize = binary.LittleEndian.Uint64(record[40:])
		directoryOffset = binary.LittleEndian.Uint64(record[48:])
	}
	if directorySize > 64<<20 || directoryOffset > uint64(size) || directorySize > uint64(size)-directoryOffset {
		return nil, fmt.Errorf("invalid or oversized ZIP directory")
	}
	data := make([]byte, int(directorySize))
	if _, err := file.ReadAt(data, int64(directoryOffset)); err != nil {
		return nil, err
	}
	entries := make(map[string][]byte)
	for len(data) > 0 {
		if len(data) < 46 || binary.LittleEndian.Uint32(data) != 0x02014b50 {
			return nil, fmt.Errorf("invalid ZIP directory entry")
		}
		nameSize := int(binary.LittleEndian.Uint16(data[28:]))
		length := 46 + nameSize + int(binary.LittleEndian.Uint16(data[30:])) + int(binary.LittleEndian.Uint16(data[32:]))
		if length > len(data) {
			return nil, fmt.Errorf("truncated ZIP directory entry")
		}
		name := string(data[46 : 46+nameSize])
		if _, exists := entries[name]; exists {
			return nil, fmt.Errorf("duplicate ZIP entry %s", name)
		}
		entries[name] = data[:length]
		data = data[length:]
	}
	return entries, nil
}

func writeArchiveDirectory(file *os.File, entries map[string][]byte) error {
	start, err := file.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	var size uint64
	for _, name := range names {
		data := entries[name]
		if _, err := file.Write(data); err != nil {
			return err
		}
		size += uint64(len(data))
	}
	// Always emit ZIP64, including archives that cross 4 GiB during this save.
	end := make([]byte, 56+20+22)
	put32 := binary.LittleEndian.PutUint32
	put64 := binary.LittleEndian.PutUint64
	put16 := binary.LittleEndian.PutUint16
	put32(end, 0x06064b50)
	put64(end[4:], 44)
	put16(end[12:], 45)
	put16(end[14:], 45)
	put64(end[24:], uint64(len(entries)))
	put64(end[32:], uint64(len(entries)))
	put64(end[40:], size)
	put64(end[48:], uint64(start))
	put32(end[56:], 0x07064b50)
	put64(end[64:], uint64(start)+size)
	put32(end[72:], 1)
	put32(end[76:], 0x06054b50)
	put16(end[84:], 0xffff)
	put16(end[86:], 0xffff)
	put32(end[88:], 0xffffffff)
	put32(end[92:], 0xffffffff)
	_, err = file.Write(end)
	return err
}

func (d *Document) appendArchiveLocked(path string) (resultErr error) {
	old, entries, err := openArchiveEntries(path)
	if err != nil {
		return err
	}
	defer old.Close()
	manifestBytes, err := readZipEntry(entries["manifest.json"], 8<<20)
	if err != nil {
		return err
	}
	var previous Manifest
	if err := json.Unmarshal(manifestBytes, &previous); err != nil {
		return err
	}
	oldBlobs := make(map[string]BlobDescriptor)
	for _, blob := range previous.Blobs {
		oldBlobs[blob.ID] = blob
	}
	directory, err := archiveDirectory(old.file, old.size)
	if err != nil {
		return err
	}
	// Restoring a revision can bring back a deleted upload whose bytes are still
	// in this inode. Reuse that historical directory entry instead of copying it.
	if d.archivePath != path {
		source, sourceEntries, err := openArchiveEntries(d.archivePath)
		if err != nil {
			return err
		}
		defer source.Close()
		sourceInfo, err := source.file.Stat()
		if err != nil {
			return err
		}
		targetInfo, err := old.file.Stat()
		if err != nil {
			return err
		}
		if os.SameFile(sourceInfo, targetInfo) {
			data, err := readZipEntry(sourceEntries["manifest.json"], 8<<20)
			if err != nil {
				return err
			}
			var sourceManifest Manifest
			if err := json.Unmarshal(data, &sourceManifest); err != nil {
				return err
			}
			sourceDirectory, err := archiveDirectory(source.file, source.size)
			if err != nil {
				return err
			}
			for _, blob := range sourceManifest.Blobs {
				if wanted, exists := d.blobs[blob.ID]; exists && wanted.SHA256 == blob.SHA256 && wanted.Size == blob.Size {
					oldBlobs[blob.ID] = blob
					directory["blobs/"+blob.ID] = sourceDirectory["blobs/"+blob.ID]
				}
			}
		}
	}
	keep := make(map[string][]byte)
	for _, blob := range d.manifest.Blobs {
		if previous, exists := oldBlobs[blob.ID]; exists && previous.SHA256 == blob.SHA256 && previous.Size == blob.Size {
			keep["blobs/"+blob.ID] = directory["blobs/"+blob.ID]
		}
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != old.size {
		return fmt.Errorf("archive changed while saving")
	}
	journal, err := json.Marshal(archiveJournal{Size: old.size})
	if err != nil {
		return err
	}
	if err := atomicWriteFile(path+".journal", journal, 0600); err != nil {
		return err
	}
	if err := syncArchiveDirectory(filepath.Dir(path)); err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			resultErr = errors.Join(resultErr, recoverArchive(path))
		}
	}()
	if _, err := file.Seek(old.size, io.SeekStart); err != nil {
		return err
	}
	writer := zip.NewWriter(file)
	writer.SetOffset(old.size)
	if err := d.writeArchiveMetadata(writer); err != nil {
		return err
	}
	for _, blob := range d.manifest.Blobs {
		if _, reused := keep["blobs/"+blob.ID]; reused {
			continue
		}
		if err := d.copyBlobToArchiveLocked(writer, blob); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	end, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	added, err := archiveDirectory(file, end)
	if err != nil {
		return err
	}
	for name, entry := range added {
		keep[name] = entry
	}
	if err := writeArchiveDirectory(file, keep); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := os.Remove(path + ".journal"); err != nil {
		return err
	}
	committed = true
	return syncArchiveDirectory(filepath.Dir(path))
}

func (d *Document) writeArchiveMetadata(writer *zip.Writer) error {
	data, err := json.MarshalIndent(d.manifest, "", "  ")
	if err != nil {
		return err
	}
	if err := writeZipBytes(writer, "manifest.json", data, zip.Deflate); err != nil {
		return err
	}
	if err := writeZipBytes(writer, "canvas.json", d.canvasJSON, zip.Deflate); err != nil {
		return err
	}
	if len(d.undoJSON) > 0 {
		return writeZipBytes(writer, "undo.json", d.undoJSON, zip.Deflate)
	}
	return nil
}

// Copy existing entries directly, including compressed legacy entries. Saving
// never requires an extracted working copy of an unchanged upload.
func (d *Document) copyBlobToArchiveLocked(writer *zip.Writer, blob BlobDescriptor) error {
	staged := filepath.Join(d.workingDir, "blobs", stagedBlobName(blob.ID))
	if _, err := os.Stat(staged); err == nil {
		return writeZipFile(writer, "blobs/"+blob.ID, staged)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	reader, entries, err := openArchiveEntries(d.archivePath)
	if err != nil {
		return err
	}
	defer reader.Close()
	entry := entries["blobs/"+blob.ID]
	if entry == nil {
		return fmt.Errorf("archive is missing blob %s", blob.ID)
	}
	if err := validateBlobEntry(entry, blob); err != nil {
		return err
	}
	return writer.Copy(entry)
}

func (d *Document) archiveUnchangedLocked(path string) (bool, error) {
	reader, entries, err := openArchiveEntries(path)
	if err != nil {
		return false, err
	}
	defer reader.Close()
	data, err := readZipEntry(entries["manifest.json"], 8<<20)
	if err != nil {
		return false, err
	}
	var previous Manifest
	if err := json.Unmarshal(data, &previous); err != nil {
		return false, err
	}
	current := d.manifest
	current.UpdatedAt = previous.UpdatedAt
	a, err := json.Marshal(current)
	if err != nil {
		return false, err
	}
	b, err := json.Marshal(previous)
	if err != nil {
		return false, err
	}
	canvas, err := readZipEntry(entries["canvas.json"], 256<<20)
	if err != nil {
		return false, err
	}
	var undo []byte
	if entries["undo.json"] != nil {
		undo, err = readZipEntry(entries["undo.json"], 4<<20)
		if err != nil {
			return false, err
		}
	}
	return bytes.Equal(a, b) && bytes.Equal(canvas, d.canvasJSON) && bytes.Equal(undo, d.undoJSON), nil
}

// Snapshot references are internal history files, never the portable document.
// The pinned inode survives rename, replacement, and deletion of the original.
const historyReferenceMagic = "KAVLA-HISTORY-1\n"

type archiveReference struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type documentArchive struct {
	*zip.Reader
	file *os.File
	size int64
}

func (a *documentArchive) Close() error { return a.file.Close() }

func readHistoryReference(path string) (*archiveReference, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	magic := make([]byte, len(historyReferenceMagic))
	if _, err := io.ReadFull(f, magic); err != nil {
		return nil, err
	}
	if string(magic) != historyReferenceMagic {
		return nil, nil
	}
	var ref archiveReference
	if err := json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&ref); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(ref.Path) || ref.Size < 22 || !strings.HasSuffix(ref.Path, ".kavla") {
		return nil, fmt.Errorf("invalid history archive reference")
	}
	return &ref, nil
}

func openDocumentArchive(path string) (*documentArchive, error) {
	ref, err := readHistoryReference(path)
	if err != nil {
		return nil, err
	}
	if ref != nil {
		path = ref.Path
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	size := info.Size()
	if ref != nil {
		if ref.Size > size {
			file.Close()
			return nil, fmt.Errorf("history backing archive is truncated")
		}
		size = ref.Size
	}
	reader, err := zip.NewReader(io.NewSectionReader(file, 0, size), size)
	if err != nil {
		file.Close()
		return nil, err
	}
	return &documentArchive{Reader: reader, file: file, size: size}, nil
}
