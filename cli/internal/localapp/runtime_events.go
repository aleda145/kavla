package localapp

import (
	"context"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"net/http"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

type runtimeSocketEvent struct {
	Stream string      `json:"stream"`
	Name   string      `json:"name"`
	Data   interface{} `json:"data"`
}

// One WebSocket carries both event streams without occupying the browser's
// HTTP connection pool, which is shared by uploads and other open Kavla tabs.
func (s *Server) handleRuntimeEvents(w http.ResponseWriter, r *http.Request) {
	settingsHeld := s.canvases != nil
	if settingsHeld {
		s.canvases.settings.RLock()
	}
	defer func() {
		if settingsHeld {
			s.canvases.settings.RUnlock()
		}
	}()
	connection, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer connection.CloseNow()
	ctx := connection.CloseRead(r.Context())

	cliEvents := make(chan cliRuntimeEvent, 64)
	agentEvents := make(chan cliRuntimeEvent, 64)
	// Shutdown closes subscribers before shutting down HTTP. Register while
	// holding workerMu so an upgraded connection cannot miss that shutdown.
	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		return
	}
	s.connections.Add(1)
	defer s.connections.Done()
	s.eventMu.Lock()
	s.eventSubscribers[cliEvents] = struct{}{}
	s.eventMu.Unlock()
	s.agentEventMu.Lock()
	s.agentSubscribers[agentEvents] = struct{}{}
	s.agentEventMu.Unlock()
	s.workerMu.Unlock()
	defer func() {
		s.eventMu.Lock()
		delete(s.eventSubscribers, cliEvents)
		s.eventMu.Unlock()
		s.agentEventMu.Lock()
		delete(s.agentSubscribers, agentEvents)
		s.agentEventMu.Unlock()
	}()

	write := func(stream string, event cliRuntimeEvent) error {
		writeContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return wsjson.Write(writeContext, connection, runtimeSocketEvent{
			Stream: stream, Name: event.name, Data: event.data,
		})
	}

	var revoked <-chan struct{}
	var editorEvents <-chan cliRuntimeEvent
	if s.canvases != nil {
		client := r.URL.Query().Get("client")
		previousGeneration := r.URL.Query().Get("generation")
		transfer := r.URL.Query().Get("transfer") == "true"
		// Waiting for the other browser must not block its save requests or
		// shared settings changes. This connection is already tracked for shutdown.
		s.canvases.settings.RUnlock()
		settingsHeld = false
		var token, generation, event string
		if transfer {
			if err := write("editor", cliRuntimeEvent{name: "opening", data: map[string]string{"message": "Waiting for the other session to save…"}}); err != nil {
				return
			}
			token, generation, err = s.transferEditor(ctx, client)
			event = "blocked"
		} else {
			s.editorMu.Lock()
			token, generation, event, err = s.acquireEditor(ctx, client, previousGeneration)
			s.editorMu.Unlock()
		}
		if token == "" {
			message := "This canvas is already open. Save and open it here, or choose another canvas."
			if err != nil {
				message = err.Error()
			}
			_ = write("editor", cliRuntimeEvent{name: event, data: map[string]string{"message": message}})
			return
		}
		s.ownerMu.RLock()
		revoked, editorEvents = s.ownerRevoked, s.ownerEvents
		s.ownerMu.RUnlock()
		defer func() {
			s.editorMu.Lock()
			defer s.editorMu.Unlock()
			s.ownerMu.RLock()
			current := s.ownerToken == token
			cancel := s.ownerCancel
			s.ownerMu.RUnlock()
			if !current {
				return
			}
			cancel()
			s.cancelAgentRun("", "The canvas editor disconnected.")
			s.ownerMu.Lock()
			defer s.ownerMu.Unlock()
			// Finish acknowledged writes before another editor can load this canvas.
			s.documentGate.Lock()
			if err := s.document.Save(); err != nil {
				s.logCLIOutput("Could not save disconnected canvas: %v\n", err)
			}
			s.documentGate.Unlock()
			s.ownerToken = ""
			s.ownerCancel = nil
		}()
		if err := write("editor", cliRuntimeEvent{name: "ready", data: map[string]string{"token": token, "generation": generation}}); err != nil {
			return
		}
	}

	// Subscribe before taking snapshots so changes during initialization are
	// queued. Reconnects recover state without replaying claimed agent work.
	s.queriesMu.RLock()
	sources := s.queries.SourceList()
	s.queriesMu.RUnlock()
	if err := write("cli", cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"sources": sources,
		"output":  s.cliOutputHistory(),
	}}); err != nil {
		return
	}
	if err := write("agent", cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"status": s.currentAgentStatus(),
		"models": s.currentAgentModels(),
		"runs":   s.currentAgentRuns(),
		"auth":   s.currentAgentAuth(),
	}}); err != nil {
		return
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-revoked:
			_ = write("editor", cliRuntimeEvent{name: "transferred", data: map[string]string{"message": "Your canvas was saved and opened in another session."}})
			return
		case event := <-editorEvents:
			if write("editor", event) != nil {
				return
			}
		case event, open := <-cliEvents:
			if !open || write("cli", event) != nil {
				return
			}
		case event, open := <-agentEvents:
			if !open || write("agent", event) != nil {
				return
			}
		case <-heartbeat.C:
			pingContext, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := connection.Ping(pingContext)
			cancel()
			if err != nil {
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

// editorMu serializes ownership transitions, including save-on-disconnect.
func (s *Server) acquireEditor(ctx context.Context, client, previousGeneration string) (string, string, string, error) {
	if err := ctx.Err(); err != nil {
		return "", "", "blocked", err
	}
	if client == "" {
		return "", "", "blocked", fmt.Errorf("an editor client ID is required")
	}
	s.workerMu.Lock()
	closing := s.closing
	s.workerMu.Unlock()
	if closing {
		return "", "", "blocked", fmt.Errorf("Kavla is closing")
	}
	s.ownerMu.RLock()
	busy, sameClient := s.ownerToken != "", s.ownerClient == client
	generation := strconv.FormatUint(s.ownerGeneration, 10)
	s.ownerMu.RUnlock()
	if busy {
		if sameClient {
			return "", "", "retry", nil
		}
		return "", "", "blocked", nil
	}
	if previousGeneration != "" && previousGeneration != generation {
		return "", "", "blocked", fmt.Errorf("another session opened this canvas; reload to use the saved version")
	}
	s.transferMu.Lock()
	pending := s.transfer != nil
	s.transferMu.Unlock()
	if pending {
		return "", "", "blocked", fmt.Errorf("the canvas is being transferred to another session")
	}
	s.ownerMu.Lock()
	defer s.ownerMu.Unlock()
	token, generation := s.grantEditor(ctx, client)
	return token, generation, "ready", nil
}

// Both editorMu and ownerMu must be held by the caller.
func (s *Server) grantEditor(ctx context.Context, client string) (string, string) {
	if s.ownerClient != client {
		s.ownerGeneration++
		s.ownerClient = client
	}
	token := uuid.NewString()
	s.ownerContext, s.ownerCancel = context.WithCancel(ctx)
	s.ownerRevoked = make(chan struct{})
	s.ownerEvents = make(chan cliRuntimeEvent, 8)
	s.ownerToken = token
	return token, strconv.FormatUint(s.ownerGeneration, 10)
}
