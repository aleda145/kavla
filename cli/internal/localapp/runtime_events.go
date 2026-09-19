package localapp

import (
	"context"
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
	s.workers.Add(1)
	defer s.workers.Done()
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
