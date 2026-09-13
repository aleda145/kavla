package session

import (
    "context"
    "database/sql"
    "os"
    "path/filepath"
    "strings"
    "testing"
    "time"

    kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
    "github.com/aleda145/kavla/cli/internal/runner"
)

func TestDiskDuckDBPythonSQL(t *testing.T) {
    executable := os.Getenv("KAVLA_TEST_PYTHON")
    if executable == "" { t.Skip("set KAVLA_TEST_PYTHON to a Python with pandas and pyarrow") }
    root := t.TempDir()
    path := filepath.Join(root, "analytics.duckdb")
    disk, err := sql.Open("duckdb", path); if err != nil { t.Fatal(err) }
    _, err = disk.Exec(`CREATE TABLE records AS SELECT range AS value, CASE WHEN range=0 THEN NULL ELSE 9007199254740993::BIGINT END AS big, 123.45::DECIMAL(10,2) AS amount, TIMESTAMP '2025-01-01 12:34:56' AS stamp FROM range(15005)`)
    if err != nil { t.Fatal(err) }
    if err := disk.Close(); err != nil { t.Fatal(err) }
    s := NewWithAllowedDirectories(map[string]kavlaconfig.SourceConfig{"disk": {Type: "duckdb", Connection: path}}, []string{root})
    if err := s.Start(); err != nil { t.Fatal(err) }; defer s.Close()
    ctx := context.Background()
    client := &stubClient{}
    if _, err := s.RunQuery(ctx, client, runner.QueryRequest{ShapeId: "shape:sql", QueryName: "query_1", SQL: "SELECT * FROM disk.records"}); err != nil { t.Fatal(err) }
    request := PythonRequest{ShapeID: "shape:python", Name: "python_1", Inputs: map[string]string{"query_1": "shape:sql"}, Code: `from decimal import Decimal
import pandas as pd
assert len(query_1) == 15005
assert pd.isna(query_1.big.iloc[0])
assert query_1.big.iloc[1] == 9007199254740993
assert query_1.amount.iloc[0] == Decimal('123.45')
assert str(query_1.stamp.iloc[0]) == '2025-01-01 12:34:56'
assert 'old_variable' not in globals()
old_variable = 42
print('full input received')
result = query_1.assign(doubled=query_1.value * 2)
`}
    result, err := s.RunPython(ctx, executable, root, request)
    if err != nil || result.Error != "" { t.Fatalf("Python failed: %+v %v", result, err) }
    if result.RowCount != 15005 || !strings.Contains(result.Output, "full input received") { t.Fatalf("unexpected result: %+v", result) }
    result, err = s.RunPython(ctx, executable, root, request)
    if err != nil || result.Error != "" { t.Fatalf("second run inherited state: %+v %v", result, err) }
    downstream, err := s.RunQuery(ctx, client, runner.QueryRequest{ShapeId: "shape:downstream", SQL: "WITH filtered AS (SELECT * FROM python_1 WHERE doubled >= 30000) SELECT * FROM filtered", ResultBindings: map[string]string{"python_1": request.ShapeID}})
    if err != nil { t.Fatal(err) }
    if downstream.RowCount != 5 { t.Fatalf("unexpected downstream rows: %d", downstream.RowCount) }
    exportPath := filepath.Join(root, "download.parquet")
    if _, err := s.ExportQueryResult(ctx, request.ShapeID, "parquet", exportPath); err != nil { t.Fatal(err) }
    if stat, err := os.Stat(exportPath); err != nil || stat.Size() == 0 { t.Fatal("missing result download") }
    for _, code := range []string{"result = 42", "raise RuntimeError('deliberate')", "import pandas as pd\nresult = pd.DataFrame([[1,2]], columns=['x','x'])"} {
        request.Code = code
        failed, err := s.RunPython(ctx, executable, root, request)
        if err != nil || failed.Error == "" { t.Fatalf("expected structured Python error: %+v %v", failed, err) }
        count, err := s.engine.ResultRowCount(ctx, request.ShapeID)
        if err != nil || count != 15005 { t.Fatal("failed run replaced previous result") }
    }
    request.Code = "result = query_1.iloc[:0]"
    result, err = s.RunPython(ctx, executable, root, request)
    if err != nil || result.Error != "" || result.RowCount != 0 || len(result.Schema) != 4 { t.Fatalf("empty schema lost: %+v %v", result, err) }
    request.Code = "import time\ntime.sleep(60)\nresult = query_1"
    cancelled, cancel := context.WithTimeout(ctx, 200*time.Millisecond); defer cancel()
    if _, err := s.RunPython(cancelled, executable, root, request); err == nil { t.Fatal("run was not cancelled") }
    if err := s.DropResults(ctx, []string{request.ShapeID}); err != nil { t.Fatal(err) }
    if s.HasQueryResult(request.ShapeID) { t.Fatal("deleted result still registered") }
}
