package localapp

import (
	"context"
	"os"
	"time"

	"github.com/aleda145/kavla/cli/internal/updater"
)

type versionInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	ReleaseURL     string `json:"releaseURL"`
	Status         string `json:"status"`
}

// SetVersion is called before starting the server. Version information is
// process state and is never written into a .kavla document.
func (s *Server) SetVersion(version string) {
	status := "checking"
	if os.Getenv("KAVLA_NO_UPDATE_CHECK") == "1" {
		status = "disabled"
	} else if !updater.IsManagedVersion(version) {
		status = "development"
	}
	s.versionMu.Lock()
	s.versionInfo = versionInfo{CurrentVersion: version, ReleaseURL: updater.ReleasesURL, Status: status}
	s.versionMu.Unlock()
}

func (s *Server) currentVersionInfo() versionInfo {
	owner := s
	if s.canvases != nil {
		owner = s.canvases.root
	}
	owner.versionMu.RLock()
	defer owner.versionMu.RUnlock()
	return owner.versionInfo
}

// CheckForUpdates checks release metadata in the background, without downloading
// or installing a binary. Call once after starting the server.
func (s *Server) CheckForUpdates() {
	info := s.currentVersionInfo()
	s.logCLIOutput("Kavla %s\n", info.CurrentVersion)
	if info.Status != "checking" {
		return
	}
	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		return
	}
	s.workers.Add(1)
	s.workerMu.Unlock()
	go func() {
		defer s.workers.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result, err := updater.New().Check(ctx, info.CurrentVersion)
		if err != nil {
			info.Status = "error"
			s.logCLIOutput("Could not check for Kavla updates: %v\n", err)
		} else {
			info.LatestVersion = result.LatestVersion
			info.Status = "current"
			if result.NotesURL != "" {
				info.ReleaseURL = result.NotesURL
			}
			if result.UpdateAvailable {
				info.Status = "update"
				s.logCLIOutput("Kavla %s is available (current: %s). View release notes and update manually: %s\n", info.LatestVersion, info.CurrentVersion, info.ReleaseURL)
			}
		}
		s.versionMu.Lock()
		s.versionInfo = info
		s.versionMu.Unlock()
		event := cliRuntimeEvent{name: "version", data: info}
		if s.canvases != nil {
			for _, runtime := range s.canvases.snapshot() {
				runtime.broadcastRuntimeEvent(event)
			}
		} else {
			s.broadcastRuntimeEvent(event)
		}
	}()
}
