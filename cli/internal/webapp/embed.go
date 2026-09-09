package webapp

import (
	"embed"
	"fmt"
	"io/fs"
)

//go:embed dist
var embedded embed.FS

func Files() (fs.FS, error) {
	files, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, fmt.Errorf("open embedded Kavla app: %w", err)
	}
	return files, nil
}
