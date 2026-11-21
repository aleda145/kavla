package transport

import (
	"bytes"
	"encoding/json"
	"fmt"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/session"
)

type duckDBSettingsRequest struct {
	Action   string `json:"action"`
	Settings *struct {
		Memory        kavlaconfig.MemoryConfig `json:"memory"`
		DuckDBThreads *int                     `json:"duckdbThreads"`
	} `json:"settings"`
}

func (m *Manager) handleDuckDBSettings(message map[string]interface{}) {
	id, _ := message["requestId"].(string)
	if id == "" {
		return
	}
	result, err := m.duckDBSettings(message["payload"])
	response := map[string]interface{}{"type": "cli_duckdb_settings_response", "requestId": id, "payload": result}
	if err != nil {
		response = map[string]interface{}{"type": "error", "requestId": id, "error": err.Error()}
	}
	if err := m.client.SendJSON(response); err != nil {
		m.Log("Could not send DuckDB settings response: %v", err)
	}
}

func (m *Manager) duckDBSettings(payload interface{}) (map[string]interface{}, error) {
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > 4096 {
		return nil, fmt.Errorf("invalid DuckDB settings")
	}
	var request duckDBSettingsRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return nil, err
	}
	switch request.Action {
	case "get":
		m.sessionMu.RLock()
		defer m.sessionMu.RUnlock()
	case "restart":
		// Serialize configuration writes with source changes and leave running queries alone.
		if !m.sessionMu.TryLock() {
			return nil, fmt.Errorf("the CLI is busy; try again after the current operation finishes")
		}
		defer m.sessionMu.Unlock()
	default:
		return nil, fmt.Errorf("unknown DuckDB settings action")
	}
	if err := m.context.Err(); err != nil {
		return nil, err
	}
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return nil, err
	}
	if request.Action == "restart" {
		if settings := request.Settings; settings != nil {
			config.Memory = settings.Memory
			config.DuckDBThreads = settings.DuckDBThreads
			if err := kavlaconfig.SaveConfig(config); err != nil {
				return nil, err
			}
			m.Log("Updated DuckDB settings for future worker starts")
		}
		if err := m.session.RestartCompute(m.context); err != nil {
			return nil, fmt.Errorf("could not start DuckDB with the saved settings: %w", err)
		}
	}
	result := session.ComputeSettings(config)
	stats := m.session.ComputeStats()
	result["running"] = stats.PID != 0
	result["threadsLimit"] = stats.ThreadsLimit
	return result, nil
}
