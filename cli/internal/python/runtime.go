package python

import (
    "archive/tar"
    "bytes"
    "compress/gzip"
    "context"
    "crypto/sha256"
    _ "embed"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "os/exec"
    "path/filepath"
    "regexp"
    "runtime"
    "strings"
    "sync"
    "time"
)

//go:embed worker.py
var worker []byte

const UVVersion = "0.12.13"
var archives = map[string]struct{ Name, SHA string }{
    "linux/amd64": {"uv-x86_64-unknown-linux-gnu.tar.gz", "745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd"},
    "linux/arm64": {"uv-aarch64-unknown-linux-gnu.tar.gz", "2eaa5d94f5db7b3a1a092156b9420459e42ab0217d917fe74a876309cef9b5e9"},
    "darwin/amd64": {"uv-x86_64-apple-darwin.tar.gz", "5e287ef61cb6a9b61b3a83fef124fd143e400468a7dac794230147a810e17119"},
    "darwin/arm64": {"uv-aarch64-apple-darwin.tar.gz", "7e6ddb9316acc00f2296c82ff4d99977870ee34b2f0ddcae9444d714db9364ed"},
}

type Config struct {
    Version string `json:"version"`
    Requirements []string `json:"requirements"`
    Lock string `json:"lock,omitempty"`
}

func DefaultConfig() Config { return Config{Version: "3.13", Requirements: []string{"pandas", "numpy", "pyarrow"}} }

type Response struct {
    Dependencies []string `json:"dependencies"`
    Error string `json:"error,omitempty"`
    Line int `json:"line,omitempty"`
    Column int `json:"column,omitempty"`
    Traceback string `json:"traceback,omitempty"`
    Output string `json:"output,omitempty"`
}

type Runtime struct {
    Root string
    UV string // Tests may supply an installed uv; production provisions the pinned binary.
    Log func(string, ...interface{})
    mu sync.Mutex
}

func New(log func(string, ...interface{})) *Runtime { return &Runtime{Log: log} }
func (r *Runtime) root() (string, error) {
    if r.Root != "" { return r.Root, nil }
    home, err := os.UserHomeDir()
    if err != nil { return "", err }
    return filepath.Join(home, ".kavla", "python"), nil
}

var requirementPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9_,.-]+\])?([<>=!~][A-Za-z0-9.*<>=!~, +_-]+)?$`)
var versionPattern = regexp.MustCompile(`^3\.13(\.[0-9]+)?$`)

func ValidateConfig(config Config) error {
    if !versionPattern.MatchString(config.Version) { return fmt.Errorf("Python version must be 3.13 or an exact 3.13 patch version") }
    if len(config.Requirements) > 100 { return fmt.Errorf("at most 100 Python requirements are supported") }
    for _, requirement := range config.Requirements {
        if !requirementPattern.MatchString(requirement) { return fmt.Errorf("invalid requirement %q; use a package name and optional version constraints", requirement) }
    }
    return nil
}

func (r *Runtime) uv(ctx context.Context, root string) (string, error) {
    if r.UV != "" { return r.UV, nil }
    target := filepath.Join(root, "tools", UVVersion, "uv")
    if _, err := os.Stat(target); err == nil { return target, nil }
    archive, ok := archives[runtime.GOOS+"/"+runtime.GOARCH]
    if !ok { return "", fmt.Errorf("managed Python is not available for %s/%s", runtime.GOOS, runtime.GOARCH) }
    if r.Log != nil { r.Log("Preparing Python: downloading uv %s\n", UVVersion) }
    request, err := http.NewRequestWithContext(ctx, "GET", "https://github.com/astral-sh/uv/releases/download/"+UVVersion+"/"+archive.Name, nil)
    if err != nil { return "", err }
    response, err := (&http.Client{Timeout: 5*time.Minute}).Do(request)
    if err != nil { return "", fmt.Errorf("download Python installer: %w", err) }
    defer response.Body.Close()
    if response.StatusCode != http.StatusOK { return "", fmt.Errorf("download Python installer: HTTP %d", response.StatusCode) }
    data, err := io.ReadAll(io.LimitReader(response.Body, 100<<20))
    if err != nil { return "", err }
    sum := sha256.Sum256(data)
    if hex.EncodeToString(sum[:]) != archive.SHA { return "", fmt.Errorf("Python installer checksum mismatch") }
    zipped, err := gzip.NewReader(bytes.NewReader(data))
    if err != nil { return "", err }
    defer zipped.Close()
    reader := tar.NewReader(zipped)
    for {
        header, err := reader.Next()
        if err != nil { return "", fmt.Errorf("extract Python installer: %w", err) }
        if filepath.Base(header.Name) != "uv" || header.Typeflag != tar.TypeReg { continue }
        if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil { return "", err }
        file, err := os.CreateTemp(filepath.Dir(target), ".uv-*")
        if err != nil { return "", err }
        defer os.Remove(file.Name())
        _, copyErr := io.Copy(file, reader)
        closeErr := file.Close()
        if copyErr != nil { return "", copyErr }; if closeErr != nil { return "", closeErr }
        if err := os.Chmod(file.Name(), 0700); err != nil { return "", err }
        if err := os.Rename(file.Name(), target); err != nil { return "", err }
        return target, nil
    }
}

type boundedOutput struct { bytes.Buffer }
func (b *boundedOutput) Write(p []byte) (int, error) {
    n := len(p)
    available := (256<<10)-b.Len()
    if available > 0 { _, _ = b.Buffer.Write(p[:min(available, len(p))]) }
    return n, nil
}

func runCommand(ctx context.Context, executable string, args []string, dir string, stdin []byte, env []string) (string, error) {
    command := exec.CommandContext(ctx, executable, args...)
    configureProcess(command)
    command.WaitDelay = 2*time.Second
    command.Dir = dir
    command.Stdin = bytes.NewReader(stdin)
    command.Env = append(os.Environ(), env...)
    var output boundedOutput
    command.Stdout = &output
    command.Stderr = &output
    err := command.Run()
    if command.Process != nil { _ = command.Cancel() } // Clean up children even when the script exits successfully.
    if ctx.Err() != nil { return output.String(), ctx.Err() }
    if err != nil { return output.String(), fmt.Errorf("%w\n%s", err, output.String()) }
    return output.String(), nil
}

// Ensure changes only the requested environment revision. Previous revisions remain usable.
func (r *Runtime) Ensure(ctx context.Context, documentID string, config Config) (string, Config, error) {
    r.mu.Lock()
    defer r.mu.Unlock()
    if err := ValidateConfig(config); err != nil { return "", config, err }
    if executable, ok := r.Prepared(documentID, config); ok { return executable, config, nil }
    root, err := r.root(); if err != nil { return "", config, err }
    identity := sha256.Sum256([]byte(documentID))
    encoded, _ := json.Marshal(config)
    revision := sha256.Sum256(encoded)
    directory := filepath.Join(root, "environments", fmt.Sprintf("%x", identity[:16]), fmt.Sprintf("%x", revision[:16]))
    executable := filepath.Join(directory, ".venv", "bin", "python")
    if data, err := os.ReadFile(filepath.Join(directory, "ready.json")); err == nil {
        var ready Config
        if err := json.Unmarshal(data, &ready); err != nil { return "", config, err }
        if _, err := os.Stat(executable); err == nil { return executable, ready, nil }
    }
    uv, err := r.uv(ctx, root); if err != nil { return "", config, err }
    if err := os.MkdirAll(directory, 0700); err != nil { return "", config, err }
    requirements := append([]string{"pandas", "numpy", "pyarrow"}, config.Requirements...)
    deps, _ := json.Marshal(requirements)
    project := fmt.Sprintf("[project]\nname = \"kavla-canvas\"\nversion = \"0.0.0\"\nrequires-python = \">=3.13,<3.14\"\ndependencies = %s\n", deps)
    if err := os.WriteFile(filepath.Join(directory, "pyproject.toml"), []byte(project), 0600); err != nil { return "", config, err }
    if config.Lock != "" {
        if err := os.WriteFile(filepath.Join(directory, "uv.lock"), []byte(config.Lock), 0600); err != nil { return "", config, err }
    }
    args := []string{"sync", "--managed-python", "--python", config.Version, "--no-dev", "--no-install-project"}
    if config.Lock != "" { args = append(args, "--locked") }
    if r.Log != nil { r.Log("Preparing Python environment and packages…\n") }
    env := []string{"UV_PYTHON_INSTALL_DIR="+filepath.Join(root, "interpreters"), "UV_CACHE_DIR="+filepath.Join(root, "cache"), "UV_NO_CONFIG=1", "UV_NO_PROGRESS=1"}
    output, err := runCommand(ctx, uv, args, directory, nil, env)
    if r.Log != nil && output != "" { r.Log("%s", output) }
    if err != nil { return "", config, fmt.Errorf("prepare Python environment: %w", err) }
    lock, err := os.ReadFile(filepath.Join(directory, "uv.lock")); if err != nil { return "", config, err }
    version, err := runCommand(ctx, executable, []string{"-I", "-c", "import platform; print(platform.python_version())"}, directory, nil, nil)
    if err != nil { return "", config, err }
    config.Version, config.Lock = strings.TrimSpace(version), string(lock)
    ready, _ := json.Marshal(config)
    if err := os.WriteFile(filepath.Join(directory, "ready.json"), ready, 0600); err != nil { return "", config, err }
    // Address the prepared environment by both requested and resolved configuration.
    // The pointer avoids moving virtualenvs, whose scripts contain absolute paths.
    resolved := sha256.Sum256(ready)
    pointer := filepath.Join(root, "environments", fmt.Sprintf("%x", identity[:16]), fmt.Sprintf("%x.path", resolved[:16]))
    if err := os.WriteFile(pointer, []byte(directory), 0600); err != nil { return "", config, err }
    return executable, config, nil
}

func (r *Runtime) Prepared(documentID string, config Config) (string, bool) {
    root, err := r.root(); if err != nil { return "", false }
    identity := sha256.Sum256([]byte(documentID)); data, _ := json.Marshal(config); revision := sha256.Sum256(data)
    base := filepath.Join(root, "environments", fmt.Sprintf("%x", identity[:16]))
    directory := filepath.Join(base, fmt.Sprintf("%x", revision[:16]))
    if pointer, err := os.ReadFile(filepath.Join(base, fmt.Sprintf("%x.path", revision[:16]))); err == nil { directory = string(pointer) }
    if _, err := os.Stat(filepath.Join(directory, "ready.json")); err != nil { return "", false }
    executable := filepath.Join(directory, ".venv", "bin", "python")
    _, err = os.Stat(executable)
    return executable, err == nil
}

func Invoke(ctx context.Context, executable, directory string, request map[string]interface{}) (Response, error) {
    script := filepath.Join(directory, "worker.py")
    responsePath := filepath.Join(directory, "response.json")
    if err := os.WriteFile(script, worker, 0600); err != nil { return Response{}, err }
    request["response"] = responsePath
    data, err := json.Marshal(request); if err != nil { return Response{}, err }
    output, err := runCommand(ctx, executable, []string{"-I", "-u", script}, directory, data, nil)
    if err != nil { return Response{Output: output}, err }
    encoded, err := os.ReadFile(responsePath); if err != nil { return Response{}, fmt.Errorf("Python exited without producing a result: %w", err) }
    var response Response
    if err := json.Unmarshal(encoded, &response); err != nil { return Response{}, err }
    response.Output = output
    return response, nil
}
