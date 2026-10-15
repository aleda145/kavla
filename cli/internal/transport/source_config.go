package transport

import (
	"encoding/json"
	"fmt"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/aleda145/kavla/cli/internal/sources"
)

func (m *Manager) withSession(operation func(*session.Session)) {
	m.sessionMu.RLock()
	defer m.sessionMu.RUnlock()
	if m.context.Err() == nil {
		operation(m.session)
	}
}

func (m *Manager) handleSourceConfig(message map[string]interface{}) {
	requestID, _ := message["requestId"].(string)
	if requestID == "" {
		return
	}
	messageType, _ := message["type"].(string)
	var result interface{}
	var err error
	if messageType == "get_cli_source_paths" {
		payload, _ := message["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		result, err = sources.ListSourcePaths(path)
	} else {
		var request sources.ConfigChange
		var encoded []byte
		encoded, err = json.Marshal(message["payload"])
		if err == nil && len(encoded) > 64<<10 {
			err = fmt.Errorf("source configuration request is too large")
		}
		if err == nil {
			err = json.Unmarshal(encoded, &request)
		}
		if err == nil {
			result, err = m.configureSources(request)
		}
	}
	response := map[string]interface{}{"type": messageType + "_response", "requestId": requestID, "payload": result}
	if err != nil {
		response = map[string]interface{}{"type": "error", "requestId": requestID, "error": err.Error()}
	}
	if err := m.client.SendJSON(response); err != nil {
		m.Log("Could not send source configuration response: %v\n", err)
	}
}

func (m *Manager) configureSources(request sources.ConfigChange) (interface{}, error) {
	if request.Action == "list" {
		m.sessionMu.RLock()
		defer m.sessionMu.RUnlock()
		return m.sourceConfiguration()
	}
	// Replacing a session must not interrupt an active query or metadata request.
	if !m.sessionMu.TryLock() {
		return nil, fmt.Errorf("the CLI is busy; wait for running queries to finish, then save the source again")
	}
	defer m.sessionMu.Unlock()
	if m.context.Err() != nil {
		return nil, fmt.Errorf("the CLI is disconnecting")
	}
	config, err := sources.PrepareConfigChange(request)
	if err != nil {
		return nil, err
	}
	next := session.New(config.Sources)
	next.SetLogger(m.Log)
	next.SetVerboseLogger(m.Verbose)
	if err := next.Start(); err != nil {
		return nil, fmt.Errorf("start updated CLI sources: %w", err)
	}
	if m.context.Err() != nil {
		_ = next.Close()
		return nil, fmt.Errorf("the CLI disconnected before saving")
	}
	if err := kavlaconfig.SaveConfig(config); err != nil {
		_ = next.Close()
		return nil, fmt.Errorf("save CLI configuration: %w", err)
	}
	previous := m.session
	m.session = next
	if err := previous.Close(); err != nil {
		m.Log("Could not close previous source session: %v\n", err)
	}
	// Broadcast only public source status; connection strings go to the requesting owner.
	if err := m.client.SendJSON(map[string]interface{}{"type": "cli_sources", "payload": hostedSourceList(next.SourceList())}); err != nil {
		return nil, fmt.Errorf("sources saved, but could not announce updated sources: %w", err)
	}
	return m.sourceConfiguration()
}

func (m *Manager) sourceConfiguration() (sources.Configuration, error) {
	return sources.DescribeConfig(m.session.Sources(), hostedSourceList(m.session.SourceList()), false)
}
