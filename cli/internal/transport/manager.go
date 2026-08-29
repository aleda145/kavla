package transport

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/aleda145/kavla/cli/internal/session"
	"nhooyr.io/websocket"
)

type DisconnectReason string

const (
	DisconnectReasonLocalShutdown DisconnectReason = "local_shutdown"
	DisconnectReasonRemoteClose   DisconnectReason = "remote_close"
	DisconnectReasonReadError     DisconnectReason = "read_error"
)

type DisconnectEvent struct {
	Reason DisconnectReason
	Err    error
}

type Manager struct {
	client   *Client
	session  *session.Session
	verbose  bool
	context  context.Context
	cancel   context.CancelFunc
	prepared bool

	Done     chan DisconnectEvent
	stopOnce sync.Once
	doneOnce sync.Once
}

func NewManager(workerURL, roomID, token string, sources map[string]kavlaconfig.SourceConfig, verbose bool) *Manager {
	return &Manager{
		client:  NewClient(workerURL, roomID, token),
		session: session.New(sources),
		verbose: verbose,
		Done:    make(chan DisconnectEvent, 1),
	}
}

func (m *Manager) Prepare() error {
	if m.prepared {
		return nil
	}
	m.session.SetLogger(m.Log)
	m.session.SetVerboseLogger(m.Verbose)
	if err := m.session.Start(); err != nil {
		return fmt.Errorf("start CLI sources: %w", err)
	}
	m.prepared = true
	return nil
}

func (m *Manager) Start() error {
	if err := m.Prepare(); err != nil {
		return err
	}
	m.context, m.cancel = context.WithCancel(context.Background())
	if err := m.client.Connect(m.context); err != nil {
		return err
	}
	if err := m.client.SendJSON(map[string]interface{}{
		"type":    "cli_sources",
		"payload": hostedSourceList(m.session.SourceList()),
	}); err != nil {
		_ = m.client.Close()
		return fmt.Errorf("send CLI source list: %w", err)
	}

	m.Log("Connected to Kavla.dev. Waiting for queries... (Ctrl+C to disconnect)\n")
	go m.readLoop()
	return nil
}

func hostedSourceList(sources []map[string]interface{}) []map[string]interface{} {
	hosted := make([]map[string]interface{}, 0, len(sources))
	for _, source := range sources {
		entry := make(map[string]interface{}, len(source))
		for key, value := range source {
			if key != "error" {
				entry[key] = value
			}
		}
		if available, ok := entry["available"].(bool); ok && !available {
			entry["error"] = "Source is unavailable. Check the Kavla CLI terminal."
		}
		hosted = append(hosted, entry)
	}
	return hosted
}

func (m *Manager) readLoop() {
	for {
		message, err := m.client.Read(m.context)
		if err != nil {
			event := classifyDisconnect(err)
			m.Stop(event.Reason, event.Err)
			return
		}
		if m.client.ResolvePending(message) {
			continue
		}
		m.handleMessage(message)
	}
}

func (m *Manager) handleMessage(message map[string]interface{}) {
	messageType, _ := message["type"].(string)
	switch messageType {
	case "get_source_tables":
		request, err := ParseGetSourceTablesMessage(message)
		if err != nil {
			m.Log("Invalid table list request: %v\n", err)
			return
		}
		go m.session.HandleGetTables(m.client, request.RequestID, request.SourceName)
	case "get_source_schema":
		request, err := ParseGetSourceSchemaMessage(message)
		if err != nil {
			m.Log("Invalid schema request: %v\n", err)
			return
		}
		go m.session.HandleGetSourceSchema(m.client, request.RequestID, request.TableRef)
	case "get_source_stats":
		request, err := ParseGetSourceStatsMessage(message)
		if err != nil {
			m.Log("Invalid statistics request: %v\n", err)
			return
		}
		go m.session.HandleGetSourceStats(m.client, request.RequestID, request.TableRef)
	case "query_request":
		request, err := ParseQueryRequestMessage(message)
		if err != nil {
			m.Log("Invalid query request: %v\n", err)
			return
		}
		request.PreviewRowLimit = runner.DefaultHostedPreviewRowLimit
		go m.session.HandleQuery(m.client, request)
	case "cancel_query":
		request, err := ParseCancelQueryMessage(message)
		if err != nil {
			m.Log("Invalid query cancellation: %v\n", err)
			return
		}
		m.session.CancelQuery(request.ShapeID)
	}
}

func (m *Manager) Stop(reason DisconnectReason, err error) {
	m.stopOnce.Do(func() {
		if m.cancel != nil {
			m.cancel()
		}
		if m.session != nil {
			_ = m.session.Close()
			m.prepared = false
		}
		if m.client != nil {
			_ = m.client.Close()
		}
		m.doneOnce.Do(func() {
			m.Done <- DisconnectEvent{Reason: reason, Err: err}
		})
	})
}

func (m *Manager) Log(format string, args ...interface{}) {
	line := fmt.Sprintf(format, args...)
	fmt.Print(line)
	clean := strings.TrimRight(line, "\r\n")
	if clean != "" {
		_ = m.client.SendOutput(clean)
	}
}

func (m *Manager) Verbose(format string, args ...interface{}) {
	if m.verbose {
		m.Log(format, args...)
	}
}

func classifyDisconnect(err error) DisconnectEvent {
	if err == nil || errors.Is(err, context.Canceled) {
		return DisconnectEvent{Reason: DisconnectReasonLocalShutdown, Err: err}
	}
	switch websocket.CloseStatus(err) {
	case websocket.StatusNormalClosure, websocket.StatusGoingAway:
		return DisconnectEvent{Reason: DisconnectReasonRemoteClose, Err: err}
	case -1:
		return DisconnectEvent{Reason: DisconnectReasonReadError, Err: err}
	default:
		return DisconnectEvent{Reason: DisconnectReasonRemoteClose, Err: err}
	}
}
