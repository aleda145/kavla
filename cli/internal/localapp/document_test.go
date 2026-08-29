package localapp

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDocumentRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	documentPath := filepath.Join(t.TempDir(), "analysis.kavla")
	document, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatalf("OpenDocument returned error: %v", err)
	}
	canvas := []byte(`{"tldrawFileFormatVersion":1,"schema":{},"records":[{"id":"shape-1","typeName":"shape","type":"data-source"}]}`)
	if err := document.StageCanvas(canvas); err != nil {
		t.Fatalf("StageCanvas returned error: %v", err)
	}
	source := []byte("id,value\n1,42\n")
	descriptor, err := document.PutBlob("source:shape-1", BlobDescriptor{
		Kind:     BlobKindSource,
		ShapeID:  "shape-1",
		FileName: "orders.csv",
		MIMEType: "text/csv",
	}, bytes.NewReader(source))
	if err != nil {
		t.Fatalf("PutBlob returned error: %v", err)
	}
	if descriptor.Size != int64(len(source)) || descriptor.SHA256 == "" {
		t.Fatalf("unexpected descriptor: %+v", descriptor)
	}
	if err := document.Save(); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	reopened, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatalf("reopen returned error: %v", err)
	}
	if !bytes.Equal(reopened.CanvasJSON(), canvas) {
		t.Fatalf("canvas did not round trip")
	}
	blobPath, reopenedDescriptor, err := reopened.BlobPath("source:shape-1")
	if err != nil {
		t.Fatalf("BlobPath returned error: %v", err)
	}
	data, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatalf("read blob: %v", err)
	}
	if !bytes.Equal(data, source) || reopenedDescriptor.FileName != "orders.csv" {
		t.Fatalf("blob did not round trip")
	}
}

func TestOpenDocumentIgnoresAnotherProcessWorkingCopy(t *testing.T) {
	documentPath := filepath.Join(t.TempDir(), "saved-only.kavla")
	document, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	savedCanvas := []byte(`{"records":[{"id":"shape:saved","typeName":"shape"}]}`)
	if err := document.StageCanvas(savedCanvas); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte(`{"records":[{"id":"shape:unsaved","typeName":"shape"}]}`)); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reopened.CanvasJSON(), savedCanvas) {
		t.Fatalf("startup used process-local unsaved state instead of the saved archive")
	}
}

func TestDocumentExtractsArchivedBlobsOnDemand(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	documentPath := filepath.Join(t.TempDir(), "lazy.kavla")
	document, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte(`{"records":[{"id":"shape-1","typeName":"shape","type":"data-source"}]}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := document.PutBlob("source:shape-1", BlobDescriptor{
		Kind:     BlobKindSource,
		ShapeID:  "shape-1",
		FileName: "orders.csv",
		MIMEType: "text/csv",
	}, bytes.NewReader([]byte("id\n1\n"))); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	if err := document.CleanupWorkingCopy(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	stagedPath := filepath.Join(reopened.workingDir, "blobs", "source:shape-1")
	if _, err := os.Stat(stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected blob to remain archived until requested, got %v", err)
	}
	if _, _, err := reopened.BlobPath("source:shape-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stagedPath); err != nil {
		t.Fatalf("expected requested blob to be extracted: %v", err)
	}
}

func TestSavePrunesBlobsWhoseOwnersAreNoLongerInTheCanvas(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	documentPath := filepath.Join(t.TempDir(), "pruned.kavla")
	document, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	initialCanvas := []byte(`{"records":[{"id":"shape:source-live","typeName":"shape","type":"data-source"},{"id":"shape:source-old","typeName":"shape","type":"data-source"},{"id":"shape:query-live","typeName":"shape","type":"sql-text-area"},{"id":"shape:query-old","typeName":"shape","type":"sql-text-area"},{"id":"asset:live","typeName":"asset","type":"image"},{"id":"asset:old","typeName":"asset","type":"image"}]}`)
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
			t.Fatalf("PutBlob(%q) returned error: %v", blob.id, err)
		}
	}

	currentCanvas := []byte(`{"records":[{"id":"shape:source-live","typeName":"shape","type":"data-source"},{"id":"shape:query-live","typeName":"shape","type":"sql-text-area"},{"id":"asset:live","typeName":"asset","type":"image"}]}`)
	if err := document.StageCanvas(currentCanvas); err != nil {
		t.Fatal(err)
	}
	if got := len(document.Manifest().Blobs); got != 4 {
		t.Fatalf("canvas staging must not race uploads by pruning blobs, got %d blobs", got)
	}
	if _, err := document.PutBlob("result:shape:query-live", BlobDescriptor{
		Kind:     BlobKind("result"),
		ShapeID:  "shape:query-live",
		FileName: "result.arrow",
	}, bytes.NewReader([]byte("temporary"))); err == nil {
		t.Fatal("query result blobs must not be accepted by .kavla documents")
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"source:shape:source-old", "asset:asset:old"} {
		if _, _, err := document.BlobPath(id); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("expected save to prune %q, got %v", id, err)
		}
	}

	reopened, err := OpenDocument(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(reopened.Manifest().Blobs); got != 2 {
		t.Fatalf("expected saved archive to contain 2 live blobs, got %d", got)
	}
}

func TestStaleCanvasStageDoesNotDeleteAnUploadForANewerCanvas(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "upload-race.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	staleCanvas := []byte(`{"records":[]}`)
	if err := document.StageCanvas(staleCanvas); err != nil {
		t.Fatal(err)
	}
	if _, err := document.PutBlob("source:shape:new", BlobDescriptor{
		Kind:     BlobKindSource,
		ShapeID:  "shape:new",
		FileName: "new.csv",
	}, bytes.NewReader([]byte("id\n1\n"))); err != nil {
		t.Fatal(err)
	}

	if err := document.StageCanvas(staleCanvas); err != nil {
		t.Fatal(err)
	}
	if _, _, err := document.BlobPath("source:shape:new"); err != nil {
		t.Fatalf("stale autosave deleted an in-flight upload: %v", err)
	}

	currentCanvas := []byte(`{"records":[{"id":"shape:new","typeName":"shape","type":"data-source"}]}`)
	if err := document.StageCanvas(currentCanvas); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := document.BlobPath("source:shape:new"); err != nil {
		t.Fatalf("save pruned a live uploaded source: %v", err)
	}
}

func TestReplaceFromArchiveKeepsActivePath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	targetPath := filepath.Join(t.TempDir(), "default.kavla")
	target, err := OpenDocument(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := target.StageCanvas([]byte(`{"records":[{"id":"old"}]}`)); err != nil {
		t.Fatal(err)
	}

	loadedPath := filepath.Join(t.TempDir(), "analysis.kavla")
	loaded, err := OpenDocument(loadedPath)
	if err != nil {
		t.Fatal(err)
	}
	loadedCanvas := []byte(`{"records":[{"id":"shape:loaded","typeName":"shape","type":"data-source"}]}`)
	if err := loaded.StageCanvas(loadedCanvas); err != nil {
		t.Fatal(err)
	}
	loadedBlob := []byte("id,value\n1,loaded\n")
	if _, err := loaded.PutBlob("source:loaded", BlobDescriptor{
		Kind:     BlobKindSource,
		ShapeID:  "shape:loaded",
		FileName: "loaded.csv",
		MIMEType: "text/csv",
	}, bytes.NewReader(loadedBlob)); err != nil {
		t.Fatal(err)
	}
	if err := loaded.Save(); err != nil {
		t.Fatal(err)
	}

	if err := target.ReplaceFromArchive(loadedPath); err != nil {
		t.Fatal(err)
	}
	if target.Path() != targetPath {
		t.Fatalf("expected active path %q, got %q", targetPath, target.Path())
	}
	if !bytes.Equal(target.CanvasJSON(), loadedCanvas) {
		t.Fatal("loaded canvas did not replace active canvas")
	}
	blobPath, descriptor, err := target.BlobPath("source:loaded")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatal(err)
	}
	if descriptor.FileName != "loaded.csv" || !bytes.Equal(data, loadedBlob) {
		t.Fatal("loaded blob did not replace active blobs")
	}
}

func TestSaveAsChangesActiveDocumentPathAndName(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "default.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	canvas := []byte(`{"records":[{"id":"saved-as"}]}`)
	if err := document.StageCanvas(canvas); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(t.TempDir(), "chosen-name.kavla")
	if err := document.SaveAs(targetPath); err != nil {
		t.Fatal(err)
	}
	if document.Path() != targetPath {
		t.Fatalf("expected active path %q, got %q", targetPath, document.Path())
	}
	if document.Manifest().DocumentName != "chosen-name" {
		t.Fatalf("expected document name to follow save path, got %q", document.Manifest().DocumentName)
	}
	if _, err := os.Stat(targetPath); err != nil {
		t.Fatalf("saved document does not exist: %v", err)
	}
}

func TestOpenFromPathAdoptsLoadedDocumentPath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	target, err := OpenDocument(filepath.Join(t.TempDir(), "default.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	if err := target.StageCanvas([]byte(`{"records":[{"id":"default"}]}`)); err != nil {
		t.Fatal(err)
	}
	loadedPath := filepath.Join(t.TempDir(), "loaded.kavla")
	loaded, err := OpenDocument(loadedPath)
	if err != nil {
		t.Fatal(err)
	}
	loadedCanvas := []byte(`{"records":[{"id":"loaded"}]}`)
	if err := loaded.StageCanvas(loadedCanvas); err != nil {
		t.Fatal(err)
	}
	if err := loaded.Save(); err != nil {
		t.Fatal(err)
	}
	if err := target.OpenFromPath(loadedPath); err != nil {
		t.Fatal(err)
	}
	if target.Path() != loadedPath || !bytes.Equal(target.CanvasJSON(), loadedCanvas) {
		t.Fatal("loaded document path and canvas were not adopted")
	}
}

func TestNewAtPathCreatesFreshDocumentSession(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "default.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte(`{"records":[{"id":"old"}]}`)); err != nil {
		t.Fatal(err)
	}
	oldDocumentID := document.Manifest().DocumentID
	newPath := filepath.Join(t.TempDir(), "fresh-analysis.kavla")
	newCanvas := []byte(`{"records":[]}`)
	if err := document.NewAtPath(newPath, newCanvas, false); err != nil {
		t.Fatal(err)
	}
	manifest := document.Manifest()
	if document.Path() != newPath || manifest.DocumentName != "fresh-analysis" {
		t.Fatal("new document did not adopt its selected path and name")
	}
	if manifest.DocumentID == oldDocumentID || !bytes.Equal(document.CanvasJSON(), newCanvas) || len(manifest.Blobs) != 0 {
		t.Fatal("new document session was not empty and independent")
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("new document was not saved immediately: %v", err)
	}
}

func TestNewAtPathRejectsExistingDocument(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "default.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte(`{"records":[{"id":"old"}]}`)); err != nil {
		t.Fatal(err)
	}
	originalPath := document.Path()
	originalDocumentID := document.Manifest().DocumentID
	originalCanvas := document.CanvasJSON()

	existingPath := filepath.Join(t.TempDir(), "new_canvas.kavla")
	existingContents := []byte("existing Kavla document")
	if err := os.WriteFile(existingPath, existingContents, 0600); err != nil {
		t.Fatal(err)
	}
	if err := document.NewAtPath(existingPath, []byte(`{"records":[]}`), false); !errors.Is(err, os.ErrExist) {
		t.Fatalf("expected existing document error, got %v", err)
	}
	contents, err := os.ReadFile(existingPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(contents, existingContents) {
		t.Fatalf("existing Kavla document was overwritten: %q", contents)
	}
	if document.Path() != originalPath || document.Manifest().DocumentID != originalDocumentID || !bytes.Equal(document.CanvasJSON(), originalCanvas) {
		t.Fatal("active document changed after new document conflict")
	}
}

func TestDocumentRejectsInvalidCanvasAndBlobID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "invalid.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	validCanvas := []byte(`{"records":[]}`)
	if err := document.StageCanvas(validCanvas); err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte("not-json")); err == nil {
		t.Fatal("expected invalid canvas to be rejected")
	}
	if err := document.StageCanvas([]byte(`{"document":"missing records"}`)); err == nil {
		t.Fatal("expected a canvas without records to be rejected")
	}
	if !bytes.Equal(document.CanvasJSON(), validCanvas) {
		t.Fatal("rejected canvas replaced the last valid canvas")
	}
	if _, err := document.PutBlob("../secret", BlobDescriptor{
		Kind: BlobKindSource, FileName: "data.csv",
	}, bytes.NewReader(nil)); err == nil {
		t.Fatal("expected unsafe blob id to be rejected")
	}
}

func TestDocumentRejectsUnsafeArchivePath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	documentPath := filepath.Join(t.TempDir(), "unsafe.kavla")
	file, err := os.Create(documentPath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	manifest, _ := json.Marshal(Manifest{
		FormatVersion: FormatVersion,
		DocumentID:    "doc",
		DocumentName:  "unsafe",
	})
	entries := map[string][]byte{
		"manifest.json": manifest,
		"canvas.json":   []byte(`{}`),
		"../secret":     []byte("no"),
	}
	for name, data := range entries {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write(data); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenDocument(documentPath); err == nil {
		t.Fatal("expected unsafe archive path to be rejected")
	}
}

func TestCleanupWorkingCopyRemovesTemporaryFilesAfterSave(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	document, err := OpenDocument(filepath.Join(t.TempDir(), "clean.kavla"))
	if err != nil {
		t.Fatal(err)
	}
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	workingDir := document.workingDir
	if err := document.CleanupWorkingCopy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(workingDir); !os.IsNotExist(err) {
		t.Fatalf("expected temporary working directory to be removed, got %v", err)
	}
}
