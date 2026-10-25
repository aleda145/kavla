package sources

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type DirectoryWriter interface {
	StoreParquet(ctx context.Context, snapshotPath, tableName string, db *sql.DB) error
}

func (d *directoryAdapter) StoreParquet(ctx context.Context, snapshotPath, tableName string, db *sql.DB) error {
	if directoryTableName(tableName) != tableName {
		return fmt.Errorf("directory table names cannot have leading, trailing, or consecutive underscores")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	tableRef := d.sourceName + "." + tableName
	for _, existing := range d.tableRefs {
		if strings.EqualFold(existing, tableRef) {
			return fmt.Errorf("table %s already exists", tableRef)
		}
	}
	input, err := os.Open(snapshotPath)
	if err != nil {
		return err
	}
	defer input.Close()
	file, err := os.CreateTemp(d.absDir, ".kavla-store-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, copyErr := io.Copy(file, input)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	path := filepath.Join(d.absDir, tableName+".parquet")
	// Publish atomically without replacing an existing file, including symlinks.
	if err := os.Link(file.Name(), path); err != nil {
		return fmt.Errorf("create stored Parquet file: %w", err)
	}
	statement := "CREATE VIEW " + doubleQuotedQualified([]string{d.sourceName, tableName}) + " AS SELECT * FROM read_parquet(" + sqlSingleQuoted(path) + ")"
	if _, err := db.ExecContext(ctx, statement); err != nil {
		if removeErr := os.Remove(path); removeErr != nil {
			return fmt.Errorf("create stored view: %w (remove file: %v)", err, removeErr)
		}
		return err
	}
	d.tableRefs = append(d.tableRefs, tableRef)
	slices.Sort(d.tableRefs)
	return nil
}
