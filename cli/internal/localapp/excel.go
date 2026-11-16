package localapp

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"
)

// Coordinates are zero-based and inclusive, matching the spreadsheet preview.
// The original workbook and each imported selection remain document-owned.
// Re-imports create a new table, so undo and other uses of the old table survive.
type ExcelImportConfig struct {
	WorkbookID    string `json:"workbookId"`
	Sheet         string `json:"sheet"`
	StartRow      int    `json:"startRow"`
	EndRow        int    `json:"endRow"`
	StartCol      int    `json:"startCol"`
	EndCol        int    `json:"endCol"`
	HeaderRow     *int   `json:"headerRow"`
	Columns       []int  `json:"columns"`
	SkipEmptyRows bool   `json:"skipEmptyRows"`
}

type excelSheet struct {
	Name        string     `json:"name"`
	Rows        [][]string `json:"rows"`
	ColumnCount int        `json:"columnCount"`
}

type excelWorkbook struct {
	FileName string       `json:"fileName"`
	Size     int64        `json:"size"`
	Sheets   []excelSheet `json:"sheets"`
}

func (s *Server) readExcelRequest(w http.ResponseWriter, r *http.Request) ([]byte, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 128<<20)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		return nil, "", fmt.Errorf("read workbook (maximum 128 MB): %w", err)
	}
	if id := r.FormValue("workbookId"); id != "" {
		reader, descriptor, closeBlob, err := s.document.OpenBlob(id)
		if err != nil {
			return nil, "", fmt.Errorf("open original workbook: %w", err)
		}
		defer closeBlob()
		data, err := io.ReadAll(io.LimitReader(reader, (128<<20)+1))
		if len(data) > 128<<20 {
			return nil, "", fmt.Errorf("workbook exceeds 128 MB")
		}
		return data, descriptor.FileName, err
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, "", fmt.Errorf("workbook file is required: %w", err)
	}
	defer file.Close()
	switch strings.ToLower(filepath.Ext(header.Filename)) {
	case ".xlsx", ".xlsm":
	default:
		return nil, "", fmt.Errorf("choose an .xlsx or .xlsm workbook; save older .xls files as .xlsx first")
	}
	data, err := io.ReadAll(file)
	return data, filepath.Base(header.Filename), err
}

var excelFormatLiterals = regexp.MustCompile(`"[^"]*"|\\.|\[[^\]]*\]`)

func readExcelWorkbook(ctx context.Context, data []byte, filename string) (*excelWorkbook, error) {
	file, err := excelize.OpenReader(bytes.NewReader(data), excelize.Options{UnzipSizeLimit: 512 << 20, UnzipXMLSizeLimit: 16 << 20})
	if err != nil {
		return nil, fmt.Errorf("open workbook: %w", err)
	}
	defer file.Close()
	props, err := file.GetWorkbookProps()
	if err != nil {
		return nil, err
	}
	date1904 := props.Date1904 != nil && *props.Date1904
	workbook := &excelWorkbook{FileName: filename, Size: int64(len(data)), Sheets: []excelSheet{}}
	dateStyles := make(map[int]bool)
	cellCount := 0
	for _, name := range file.GetSheetList() {
		rows, err := file.Rows(name)
		if err != nil {
			return nil, err
		}
		sheet := excelSheet{Name: name, Rows: [][]string{}}
		for rows.Next() {
			if err := ctx.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			values, err := rows.Columns(excelize.Options{RawCellValue: true})
			if err != nil {
				rows.Close()
				return nil, err
			}
			if values == nil {
				values = []string{}
			}
			cellCount += len(values)
			if cellCount > 5_000_000 || len(sheet.Rows) >= 1_048_576 {
				rows.Close()
				return nil, fmt.Errorf("workbook is too large for the selection editor (maximum 5 million cells)")
			}
			for column, value := range values {
				if value == "" {
					continue
				}
				cell, _ := excelize.CoordinatesToCellName(column+1, len(sheet.Rows)+1)
				cellType, err := file.GetCellType(name, cell)
				if err != nil {
					rows.Close()
					return nil, err
				}
				if cellType == excelize.CellTypeBool {
					if value == "1" {
						values[column] = "true"
					} else {
						values[column] = "false"
					}
					continue
				}
				if cellType != excelize.CellTypeNumber && cellType != excelize.CellTypeUnset && cellType != excelize.CellTypeFormula {
					continue
				}
				styleID, err := file.GetCellStyle(name, cell)
				if err != nil {
					rows.Close()
					return nil, err
				}
				isDate, known := dateStyles[styleID]
				if !known {
					style, err := file.GetStyle(styleID)
					if err != nil {
						rows.Close()
						return nil, err
					}
					isDate = (style.NumFmt >= 14 && style.NumFmt <= 22) || (style.NumFmt >= 45 && style.NumFmt <= 47)
					if style.CustomNumFmt != nil {
						format := strings.ToLower(excelFormatLiterals.ReplaceAllString(*style.CustomNumFmt, ""))
						isDate = strings.ContainsAny(format, "ydhs")
					}
					dateStyles[styleID] = isDate
				}
				if isDate {
					serial, parseErr := strconv.ParseFloat(value, 64)
					if parseErr != nil {
						continue
					}
					date, err := excelize.ExcelDateToTime(serial, date1904)
					if err != nil {
						rows.Close()
						return nil, fmt.Errorf("%s!%s: %w", name, cell, err)
					}
					if date.Hour() == 0 && date.Minute() == 0 && date.Second() == 0 && date.Nanosecond() == 0 {
						values[column] = date.Format("2006-01-02")
					} else {
						values[column] = date.Format("2006-01-02 15:04:05.999999999")
					}
				}
			}
			sheet.ColumnCount = max(sheet.ColumnCount, len(values))
			sheet.Rows = append(sheet.Rows, values)
		}
		iterationErr := rows.Error()
		closeErr := rows.Close()
		if iterationErr != nil {
			return nil, iterationErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		// Styled empty trailing rows should not inflate the selection grid.
		for len(sheet.Rows) > 0 && len(sheet.Rows[len(sheet.Rows)-1]) == 0 {
			sheet.Rows = sheet.Rows[:len(sheet.Rows)-1]
		}
		workbook.Sheets = append(workbook.Sheets, sheet)
	}
	return workbook, nil
}

func (s *Server) handleExcelPreview(w http.ResponseWriter, r *http.Request) {
	data, filename, err := s.readExcelRequest(w, r)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		writeAPIError(w, 400, err)
		return
	}
	workbook, err := readExcelWorkbook(r.Context(), data, filename)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	writeJSON(w, 200, workbook)
}

func excelSelectionCSV(workbook *excelWorkbook, config *ExcelImportConfig) ([]byte, error) {
	var sheet *excelSheet
	for i := range workbook.Sheets {
		if workbook.Sheets[i].Name == config.Sheet {
			sheet = &workbook.Sheets[i]
			break
		}
	}
	if sheet == nil {
		return nil, fmt.Errorf("worksheet %q does not exist", config.Sheet)
	}
	if config.StartRow < 0 || config.EndRow < config.StartRow || config.EndRow >= len(sheet.Rows) || config.StartCol < 0 || config.EndCol < config.StartCol || config.EndCol >= sheet.ColumnCount {
		return nil, fmt.Errorf("select a range inside the worksheet")
	}
	firstRow := config.StartRow
	if config.HeaderRow != nil {
		if *config.HeaderRow < config.StartRow || *config.HeaderRow > config.EndRow {
			return nil, fmt.Errorf("header row must be inside the selected range")
		}
		firstRow = *config.HeaderRow + 1
	}
	if len(config.Columns) == 0 {
		return nil, fmt.Errorf("select at least one column")
	}
	valueAt := func(row, col int) string {
		if col < len(sheet.Rows[row]) {
			return sheet.Rows[row][col]
		}
		return ""
	}
	names := make([]string, len(config.Columns))
	usedNames := make(map[string]bool)
	previousCol := -1
	for i, col := range config.Columns {
		if col < config.StartCol || col > config.EndCol || col <= previousCol {
			return nil, fmt.Errorf("selected columns must be unique, ordered, and inside the range")
		}
		previousCol = col
		base := ""
		if config.HeaderRow != nil {
			base = strings.TrimSpace(valueAt(*config.HeaderRow, col))
		}
		if base == "" {
			base = fmt.Sprintf("column_%d", col+1)
		}
		name := base
		for suffix := 2; usedNames[strings.ToLower(name)]; suffix++ {
			name = fmt.Sprintf("%s_%d", base, suffix)
		}
		usedNames[strings.ToLower(name)] = true
		names[i] = name
	}
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	if err := writer.Write(names); err != nil {
		return nil, err
	}
	count := 0
	for row := firstRow; row <= config.EndRow; row++ {
		values := make([]string, len(config.Columns))
		empty := true
		for i, col := range config.Columns {
			values[i] = valueAt(row, col)
			if strings.TrimSpace(values[i]) != "" {
				empty = false
			}
		}
		if config.SkipEmptyRows && empty {
			continue
		}
		if len(values) == 1 && values[0] == "" {
			// An unquoted blank line is skipped by CSV readers. Preserve this row.
			writer.Flush()
			if err := writer.Error(); err != nil {
				return nil, err
			}
			output.WriteString("\"\"\n")
		} else if err := writer.Write(values); err != nil {
			return nil, err
		}
		count++
	}
	if count == 0 {
		return nil, fmt.Errorf("the selected range contains no data rows")
	}
	writer.Flush()
	return output.Bytes(), writer.Error()
}

func (s *Server) handleExcelImport(w http.ResponseWriter, r *http.Request) {
	data, filename, err := s.readExcelRequest(w, r)
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	if err != nil {
		writeAPIError(w, 400, err)
		return
	}
	var config ExcelImportConfig
	if err := json.Unmarshal([]byte(r.FormValue("config")), &config); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	var expectedRowCount int64
	if value := r.FormValue("expectedRowCount"); value != "" {
		expectedRowCount, err = strconv.ParseInt(value, 10, 64)
		if err != nil || expectedRowCount < 1 {
			writeAPIError(w, 400, fmt.Errorf("expected row count must be a positive integer"))
			return
		}
	}
	workbook, err := readExcelWorkbook(r.Context(), data, filename)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	selection, err := excelSelectionCSV(workbook, &config)
	if err != nil {
		writeAPIError(w, 422, err)
		return
	}
	querySession, done, err := s.beginQueryOperation()
	if err != nil {
		writeAPIError(w, 503, err)
		return
	}
	defer done()
	ctx, cancel := querySession.OperationContext(r.Context())
	defer cancel()
	config.WorkbookID = r.FormValue("workbookId")
	newWorkbook := config.WorkbookID == ""
	id := "upload:" + uuid.NewString()
	name := uniqueUploadName(uploadBaseName(filename), s.document.Manifest().Blobs)
	complete := false
	defer func() {
		if complete {
			return
		}
		if err := querySession.DropUploadedFile(context.Background(), name); err != nil {
			s.logCLIOutput("Clean up Excel table: %v\n", err)
		}
		if err := s.document.DeleteBlob(id); err != nil && !errors.Is(err, os.ErrNotExist) {
			s.logCLIOutput("Clean up Excel selection: %v\n", err)
		}
		if newWorkbook && config.WorkbookID != "" {
			if err := s.document.DeleteBlob(config.WorkbookID); err != nil {
				s.logCLIOutput("Clean up Excel workbook: %v\n", err)
			}
		}
	}()
	if newWorkbook {
		config.WorkbookID = "workbook:" + uuid.NewString()
		if _, err := s.document.PutBlob(config.WorkbookID, BlobDescriptor{Kind: BlobKindSource, FileName: filename}, bytes.NewReader(data)); err != nil {
			writeAPIError(w, 500, err)
			return
		}
	}
	blob, err := s.document.PutBlob(id, BlobDescriptor{Kind: BlobKindSource, FileName: name + ".kavla-excel.csv", MIMEType: "text/csv", TableName: name, ExcelImport: &config}, bytes.NewReader(selection))
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	path, err := s.document.BlobURL(id)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	if err := querySession.ImportUploadedFile(ctx, name, blob.FileName, path); err != nil {
		writeAPIError(w, 422, err)
		return
	}
	tableRef := "uploaded_files.main." + name
	schema, err := querySession.GetSourceSchema(ctx, tableRef)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	stats, err := querySession.GetSourceStats(ctx, tableRef)
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	if expectedRowCount > 0 && stats["rowCount"] != expectedRowCount {
		writeAPIError(w, 422, fmt.Errorf("import read %d rows, but the worksheet contains %d data rows; choose the header and range manually", stats["rowCount"], expectedRowCount))
		return
	}
	complete = true
	s.broadcastCLISources()
	writeJSON(w, 201, map[string]interface{}{"tableName": name, "tableRef": tableRef, "blob": blob, "schema": schema, "rowCount": stats["rowCount"], "excelImport": config, "fileName": filename, "fileSize": len(data)})
}
