package localapp

import (
	"context"
	"fmt"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/session"
)

// The registry settings lock excludes requests while replacements are prepared
// and published. Event connections use their own wait group and remain live.
func (c *canvasRegistry) applySources(config *kavlaconfig.Config) error {
	runtimes := c.snapshot()
	replacements := make(map[*Server]*session.Session)
	defer func() {
		for _, querySession := range replacements {
			_ = querySession.Close()
		}
	}()
	for _, runtime := range runtimes {
		runtime.agentMu.Lock()
		active := activeAgentRun(runtime.agentRun)
		runtime.agentMu.Unlock()
		if active {
			return fmt.Errorf("stop active Agent runs before changing sources")
		}
		next := session.NewWithAllowedDirectories(config.Sources, []string{runtime.transientDir, runtime.document.workingDir})
		next.SetLogger(runtime.logCLIOutput)
		if runtime.verbose {
			next.SetVerboseLogger(runtime.logCLIOutput)
		}
		if err := next.Start(); err != nil {
			return err
		}
		replacements[runtime] = next
		if err := runtime.restoreUploads(context.Background(), next); err != nil {
			return err
		}
	}
	if err := kavlaconfig.SaveConfig(config); err != nil {
		return err
	}
	for _, runtime := range runtimes {
		runtime.queriesMu.Lock()
		previous := runtime.queries
		runtime.queries = replacements[runtime]
		delete(replacements, runtime)
		runtime.queriesMu.Unlock()
		if err := previous.Close(); err != nil {
			runtime.logCLIOutput("Could not close previous source session: %v\n", err)
		}
		runtime.broadcastCLISources()
	}
	return nil
}

func (s *Server) publishSharedAgentConfig() error {
	if s.canvases == nil {
		return nil
	}
	for _, runtime := range s.canvases.snapshot() {
		if runtime == s {
			continue
		}
		if err := runtime.loadAgentConfig(); err != nil {
			return err
		}
		runtime.retryAgentDetection()
		runtime.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "auth", data: runtime.currentAgentAuth()})
	}
	return nil
}
