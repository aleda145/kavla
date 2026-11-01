package localapp

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSavePrunesBlobsWithoutCanvasOwners(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	path := filepath.Join(t.TempDir(), "pruned.kavla")
	document, err := OpenDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })

	initialCanvas := []byte(`{"records":[{"id":"shape:source-live","typeName":"shape"},{"id":"shape:source-old","typeName":"shape"},{"id":"shape:image-live","typeName":"shape","props":{"assetId":"asset:live"}},{"id":"shape:image-old","typeName":"shape","props":{"assetId":"asset:old"}},{"id":"asset:live","typeName":"asset"},{"id":"asset:old","typeName":"asset"}]}`)
	if err := document.StageCanvas(initialCanvas); err != nil {
		t.Fatal(err)
	}
	blobs := []struct {
		id         string
		descriptor BlobDescriptor
	}{
		{"source:shape:source-live", BlobDescriptor{Kind: BlobKindSource, ShapeID: "shape:source-live", FileName: "live.csv"}},
		{"source:shape:source-old", BlobDescriptor{Kind: BlobKindSource, ShapeID: "shape:source-old", FileName: "old.csv"}},
		{"asset:asset:live", BlobDescriptor{Kind: BlobKindAsset, ShapeID: "asset:live", FileName: "live.png"}},
		{"asset:asset:old", BlobDescriptor{Kind: BlobKindAsset, ShapeID: "asset:old", FileName: "old.png"}},
	}
	for _, blob := range blobs {
		if _, err := document.PutBlob(blob.id, blob.descriptor, bytes.NewReader([]byte(blob.id))); err != nil {
			t.Fatalf("PutBlob(%q): %v", blob.id, err)
		}
	}

	currentCanvas := []byte(`{"records":[{"id":"shape:source-live","typeName":"shape"},{"id":"shape:image-live","typeName":"shape","props":{"assetId":"asset:live"}},{"id":"asset:live","typeName":"asset"}]}`)
	if err := document.StageCanvas(currentCanvas); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.CleanupWorkingCopy() })
	for _, id := range []string{"source:shape:source-live", "asset:asset:live"} {
		if _, _, err := reopened.BlobPath(id); err != nil {
			t.Fatalf("live blob %q was not saved: %v", id, err)
		}
	}
	for _, id := range []string{"source:shape:source-old", "asset:asset:old"} {
		if _, _, err := reopened.BlobPath(id); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("obsolete blob %q remains in archive: %v", id, err)
		}
	}
}
