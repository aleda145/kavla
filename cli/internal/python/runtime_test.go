package python

import (
    "context"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "testing"
    "time"
)

func TestAnalysisDoesNotExecuteCode(t *testing.T) {
    executable, err := exec.LookPath("python3"); if err != nil { t.Skip("python3 is not installed") }
    directory := t.TempDir()
    marker := filepath.Join(directory, "should-not-exist")
    response, err := Invoke(context.Background(), executable, directory, map[string]interface{}{
        "mode": "analyze", "code": "open("+"'"+marker+"'"+", 'w').write('executed')\nresult = upstream.copy()", "names": []string{"upstream"},
    })
    if err != nil { t.Fatal(err) }
    if response.Error != "" || len(response.Dependencies) != 1 { t.Fatalf("unexpected analysis: %+v", response) }
    if _, err := os.Stat(marker); !os.IsNotExist(err) { t.Fatal("analysis executed user code") }
}

func TestCancellation(t *testing.T) {
    executable, err := exec.LookPath("python3"); if err != nil { t.Skip("python3 is not installed") }
    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond); defer cancel()
    _, err = runCommand(ctx, executable, []string{"-I", "-c", "import time; time.sleep(60)"}, t.TempDir(), nil, nil)
    if err != context.DeadlineExceeded { t.Fatalf("expected deadline, got %v", err) }
}

func TestBoundedOutput(t *testing.T) {
    var output boundedOutput
    text := strings.Repeat("a", 300<<10)
    n, err := output.Write([]byte(text))
    if err != nil || n != len(text) || output.Len() != 256<<10 { t.Fatal("output was not bounded") }
}

func TestValidateRequirements(t *testing.T) {
    for _, requirement := range []string{"pandas", "scikit-learn>=1.0,<2", "numpy==2.2.0", "pandas[performance]"} {
        config := DefaultConfig(); config.Requirements = []string{requirement}
        if err := ValidateConfig(config); err != nil { t.Fatal(err) }
    }
    for _, requirement := range []string{"--index-url=https://example.com", "./local", "pkg @ https://example.com/pkg.whl", "pandas\nmalicious"} {
        config := DefaultConfig(); config.Requirements = []string{requirement}
        if err := ValidateConfig(config); err == nil { t.Fatalf("accepted %q", requirement) }
    }
}

func TestManagedEnvironment(t *testing.T) {
    if os.Getenv("KAVLA_TEST_MANAGED_PYTHON") != "1" { t.Skip("set KAVLA_TEST_MANAGED_PYTHON=1 to exercise managed downloads") }
    r := New(t.Logf); r.Root = t.TempDir()
    executable, resolved, err := r.Ensure(context.Background(), "document-a", DefaultConfig())
    if err != nil { t.Fatal(err) }
    if resolved.Lock == "" || !strings.HasPrefix(resolved.Version, "3.13.") { t.Fatalf("missing resolved config: %+v", resolved) }
    reused, err := func() (string, error) { executable, _, err := r.Ensure(context.Background(), "document-a", resolved); return executable, err }()
    if err != nil || reused != executable { t.Fatalf("did not reuse environment: %s %v", reused, err) }
    if _, ok := r.Prepared("document-b", resolved); ok { t.Fatal("another document shared the environment") }
    response, err := Invoke(context.Background(), executable, t.TempDir(), map[string]interface{}{
        "mode": "run", "code": "import pandas as pd\nresult = pd.DataFrame({'x': [1]})", "inputs": map[string]string{}, "output": filepath.Join(t.TempDir(), "output.parquet"),
    })
    if err != nil || response.Error != "" { t.Fatalf("managed Python failed: %+v %v", response, err) }
    bad := resolved; bad.Requirements = []string{"kavla-test-package-that-does-not-exist==0.0.0"}; bad.Lock = ""
    if _, _, err := r.Ensure(context.Background(), "document-a", bad); err == nil { t.Fatal("bad package unexpectedly installed") }
    if _, ok := r.Prepared("document-a", resolved); !ok { t.Fatal("failed setup damaged previous environment") }
}
