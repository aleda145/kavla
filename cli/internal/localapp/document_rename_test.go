package localapp

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRenameMovesSavedArchiveAndPersistsCurrentCanvas(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	directory := t.TempDir()
	oldPath := filepath.Join(directory, "before.kavla")
	newPath := filepath.Join(directory, "after.kavla")
	document, err := OpenDocument(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	currentCanvas := []byte(`{"records":[{"id":"shape:latest","typeName":"shape"}]}`)
	if err := document.StageCanvas(currentCanvas); err != nil {
		t.Fatal(err)
	}
	if err := document.Rename(newPath); err != nil {
		t.Fatal(err)
	}
	if document.Path() != newPath || document.Manifest().DocumentName != "after" {
		t.Fatal("rename did not update the active path and document name")
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old archive still exists: %v", err)
	}
	reopened, err := OpenDocument(newPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.CleanupWorkingCopy() })
	if reopened.Manifest().DocumentName != "after" || !bytes.Equal(reopened.CanvasJSON(), currentCanvas) {
		t.Fatal("renamed archive did not preserve its name and latest canvas")
	}
}

func TestRenameRejectsExistingArchiveWithoutChangingEitherFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	directory := t.TempDir()
	oldPath := filepath.Join(directory, "before.kavla")
	existingPath := filepath.Join(directory, "taken.kavla")
	document, err := OpenDocument(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = document.CleanupWorkingCopy() })
	if err := document.StageCanvas([]byte(`{"records":[]}`)); err != nil {
		t.Fatal(err)
	}
	if err := document.Save(); err != nil {
		t.Fatal(err)
	}
	oldContents, err := os.ReadFile(oldPath)
	if err != nil {
		t.Fatal(err)
	}
	existingContents := []byte("another canvas")
	if err := os.WriteFile(existingPath, existingContents, 0600); err != nil {
		t.Fatal(err)
	}
	if err := document.Rename(existingPath); !errors.Is(err, os.ErrExist) {
		t.Fatalf("rename conflict: got %v, want os.ErrExist", err)
	}
	if document.Path() != oldPath || document.Manifest().DocumentName != "before" {
		t.Fatal("rename conflict changed the active document")
	}
	for path, want := range map[string][]byte{oldPath: oldContents, existingPath: existingContents} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("rename conflict changed %q: %v", path, err)
		}
	}
}
