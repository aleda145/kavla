package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/mod/semver"
)

const (
	latestManifestURL = "https://github.com/aleda145/kavla/releases/latest/download/kavla_latest.json"
	cacheWindow       = 24 * time.Hour
)

var (
	ErrSourceBuild           = errors.New("source builds are not updater-managed")
	ErrUnsupportedPlatform   = errors.New("unsupported platform")
	ErrManualInstallRequired = errors.New("manual update required")
)

type Manifest struct {
	Version     string           `json:"version"`
	PublishedAt string           `json:"published_at"`
	NotesURL    string           `json:"notes_url"`
	Assets      map[string]Asset `json:"assets"`
}

type Asset struct {
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
	Format     string `json:"format"`
	BinaryName string `json:"binary_name"`
}

type State struct {
	LastCheckedAt       time.Time `json:"last_checked_at"`
	LastSeenVersion     string    `json:"last_seen_version,omitempty"`
	LastNotifiedVersion string    `json:"last_notified_version,omitempty"`
}

type CheckResult struct {
	CurrentVersion  string
	LatestVersion   string
	NotesURL        string
	UpdateAvailable bool
	ShouldNotify    bool
}

type UpdateResult struct {
	PreviousVersion string
	NewVersion      string
	NotesURL        string
	Updated         bool
}

type Updater struct {
	manifestURL    string
	statePath      string
	httpClient     *http.Client
	now            func() time.Time
	executablePath func() (string, error)
	goos           string
	goarch         string
	cacheWindow    time.Duration
}

func New() *Updater {
	return &Updater{
		manifestURL:    latestManifestURL,
		statePath:      defaultStatePath(),
		httpClient:     &http.Client{},
		now:            time.Now,
		executablePath: os.Executable,
		goos:           runtime.GOOS,
		goarch:         runtime.GOARCH,
		cacheWindow:    cacheWindow,
	}
}

func IsManagedVersion(version string) bool {
	normalized := normalizeVersion(version)
	return normalized != "" && semver.IsValid(normalized)
}

func (u *Updater) Check(ctx context.Context, currentVersion string) (CheckResult, error) {
	if !IsManagedVersion(currentVersion) {
		return CheckResult{}, ErrSourceBuild
	}

	current := normalizeVersion(currentVersion)
	state, err := u.loadState()
	if err != nil {
		return CheckResult{}, err
	}

	now := u.now()
	if !state.LastCheckedAt.IsZero() && now.Sub(state.LastCheckedAt) < u.cacheWindow {
		return u.cachedResult(current, state)
	}

	manifest, err := u.fetchManifest(ctx)
	if err != nil {
		return CheckResult{}, err
	}

	latest := normalizeVersion(manifest.Version)
	if !semver.IsValid(latest) {
		return CheckResult{}, fmt.Errorf("manifest contains invalid version %q", manifest.Version)
	}

	expired := state.LastCheckedAt.IsZero() || now.Sub(state.LastCheckedAt) >= u.cacheWindow
	state.LastCheckedAt = now
	state.LastSeenVersion = latest

	result := CheckResult{
		CurrentVersion:  current,
		LatestVersion:   latest,
		NotesURL:        manifest.NotesURL,
		UpdateAvailable: semver.Compare(latest, current) > 0,
	}
	if result.UpdateAvailable && (state.LastNotifiedVersion != latest || expired) {
		result.ShouldNotify = true
		state.LastNotifiedVersion = latest
	}

	if err := u.saveState(state); err != nil {
		return CheckResult{}, err
	}

	return result, nil
}

func (u *Updater) Update(ctx context.Context, currentVersion string) (UpdateResult, error) {
	if !IsManagedVersion(currentVersion) {
		return UpdateResult{}, ErrSourceBuild
	}

	current := normalizeVersion(currentVersion)
	manifest, err := u.fetchManifest(ctx)
	if err != nil {
		return UpdateResult{}, err
	}

	latest := normalizeVersion(manifest.Version)
	if !semver.IsValid(latest) {
		return UpdateResult{}, fmt.Errorf("manifest contains invalid version %q", manifest.Version)
	}

	result := UpdateResult{
		PreviousVersion: current,
		NewVersion:      latest,
		NotesURL:        manifest.NotesURL,
	}
	if semver.Compare(latest, current) <= 0 {
		if err := u.recordSeenVersion(latest, false); err != nil {
			return UpdateResult{}, err
		}
		return result, nil
	}

	asset, err := u.assetForCurrentPlatform(manifest)
	if err != nil {
		return UpdateResult{}, err
	}

	binaryPath, tempDir, err := u.downloadBinary(ctx, asset)
	if err != nil {
		return UpdateResult{}, err
	}
	defer os.RemoveAll(tempDir)

	targetPath, err := u.resolveExecutablePath()
	if err != nil {
		return UpdateResult{}, err
	}
	if err := replaceExecutable(targetPath, binaryPath); err != nil {
		return UpdateResult{}, err
	}

	result.Updated = true
	if err := u.recordSeenVersion(latest, true); err != nil {
		return UpdateResult{}, err
	}

	return result, nil
}

func (u *Updater) cachedResult(current string, state State) (CheckResult, error) {
	latest := normalizeVersion(state.LastSeenVersion)
	if !semver.IsValid(latest) {
		return CheckResult{CurrentVersion: current}, nil
	}

	result := CheckResult{
		CurrentVersion:  current,
		LatestVersion:   latest,
		UpdateAvailable: semver.Compare(latest, current) > 0,
	}
	if result.UpdateAvailable && state.LastNotifiedVersion != latest {
		result.ShouldNotify = true
		state.LastNotifiedVersion = latest
		if err := u.saveState(state); err != nil {
			return CheckResult{}, err
		}
	}

	return result, nil
}

func (u *Updater) recordSeenVersion(version string, markNotified bool) error {
	state, err := u.loadState()
	if err != nil {
		return err
	}
	state.LastCheckedAt = u.now()
	state.LastSeenVersion = version
	if markNotified {
		state.LastNotifiedVersion = version
	}
	return u.saveState(state)
}

func (u *Updater) fetchManifest(ctx context.Context) (Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.manifestURL, nil)
	if err != nil {
		return Manifest{}, err
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Manifest{}, fmt.Errorf("failed to fetch updater manifest: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var manifest Manifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode updater manifest: %w", err)
	}
	if manifest.Version == "" {
		return Manifest{}, errors.New("updater manifest is missing version")
	}
	if len(manifest.Assets) == 0 {
		return Manifest{}, errors.New("updater manifest has no assets")
	}
	return manifest, nil
}

func (u *Updater) assetForCurrentPlatform(manifest Manifest) (Asset, error) {
	key := platformKey(u.goos, u.goarch)
	if key == "" {
		return Asset{}, fmt.Errorf("%w: %s/%s", ErrUnsupportedPlatform, u.goos, u.goarch)
	}

	asset, ok := manifest.Assets[key]
	if !ok {
		return Asset{}, fmt.Errorf("%w: no release asset for %s", ErrUnsupportedPlatform, key)
	}
	if asset.URL == "" || asset.SHA256 == "" {
		return Asset{}, fmt.Errorf("release asset for %s is incomplete", key)
	}
	if asset.Format != "binary" {
		return Asset{}, fmt.Errorf("unsupported release asset format %q", asset.Format)
	}
	if asset.BinaryName == "" {
		asset.BinaryName = "kavla"
	}
	if asset.BinaryName != "kavla" {
		return Asset{}, fmt.Errorf("unexpected binary name %q", asset.BinaryName)
	}
	return asset, nil
}

func (u *Updater) downloadBinary(ctx context.Context, asset Asset) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return "", "", err
	}

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", "", fmt.Errorf("failed to download release binary: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	tempDir, err := os.MkdirTemp("", "kavla-update-*")
	if err != nil {
		return "", "", err
	}

	binaryPath := filepath.Join(tempDir, asset.BinaryName)
	file, err := os.Create(binaryPath)
	if err != nil {
		os.RemoveAll(tempDir)
		return "", "", err
	}

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(file, hasher), resp.Body); err != nil {
		file.Close()
		os.RemoveAll(tempDir)
		return "", "", err
	}
	if err := file.Close(); err != nil {
		os.RemoveAll(tempDir)
		return "", "", err
	}

	actual := hex.EncodeToString(hasher.Sum(nil))
	if !strings.EqualFold(actual, asset.SHA256) {
		os.RemoveAll(tempDir)
		return "", "", fmt.Errorf("checksum mismatch: expected %s, got %s", asset.SHA256, actual)
	}

	return binaryPath, tempDir, nil
}

func (u *Updater) resolveExecutablePath() (string, error) {
	executablePath, err := u.executablePath()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(executablePath); err == nil {
		executablePath = resolved
	}
	return executablePath, nil
}

func replaceExecutable(targetPath, sourcePath string) error {
	targetDir := filepath.Dir(targetPath)
	sourceFile, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	tempFile, err := os.CreateTemp(targetDir, ".kavla-update-*")
	if err != nil {
		return fmt.Errorf("%w: executable directory is not writable: %v", ErrManualInstallRequired, err)
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	if _, err := io.Copy(tempFile, sourceFile); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Chmod(0755); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return fmt.Errorf("%w: %v", ErrManualInstallRequired, err)
	}
	return nil
}

func platformKey(goos, goarch string) string {
	switch {
	case goos == "linux" && goarch == "amd64":
		return "linux-amd64"
	case goos == "linux" && goarch == "arm64":
		return "linux-arm64"
	case goos == "darwin" && goarch == "arm64":
		return "darwin-arm64"
	default:
		return ""
	}
}

func normalizeVersion(version string) string {
	version = strings.TrimSpace(version)
	if version == "" || strings.EqualFold(version, "dev") {
		return ""
	}
	if strings.HasPrefix(version, "v") {
		return version
	}
	return "v" + version
}

func defaultStatePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".kavla", "updater.json")
}

func (u *Updater) loadState() (State, error) {
	if u.statePath == "" {
		return State{}, nil
	}

	data, err := os.ReadFile(u.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return State{}, err
	}

	var state State
	if err := json.Unmarshal(data, &state); err != nil {
		return State{}, nil
	}
	return state, nil
}

func (u *Updater) saveState(state State) error {
	if u.statePath == "" {
		return nil
	}

	dir := filepath.Dir(u.statePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}

	data, err := json.Marshal(state)
	if err != nil {
		return err
	}

	tempFile, err := os.CreateTemp(dir, ".updater-*.json")
	if err != nil {
		return err
	}
	tempPath := tempFile.Name()
	defer os.Remove(tempPath)

	if _, err := tempFile.Write(data); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Chmod(0600); err != nil {
		tempFile.Close()
		return err
	}
	if err := tempFile.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, u.statePath)
}
