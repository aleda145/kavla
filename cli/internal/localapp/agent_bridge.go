package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/agent"
)

const agentOperationTimeout = 45 * time.Second

func (s *Server) startAgentDetection() {
	s.agentMu.Lock()
	if s.agentStarting || s.agentClient != nil {
		s.agentMu.Unlock()
		return
	}
	mode, apiKey, _ := s.agentAuthLocked()
	config := s.apiProviderLocked()
	config.APIKey = apiKey
	s.agentStarting = true
	s.agentStatus = agent.Status{State: "checking", Message: "Preparing Agent connection…"}
	ctx, cancel := context.WithCancel(context.Background())
	s.agentContext = ctx
	s.agentCancel = cancel
	s.agentMu.Unlock()
	s.broadcastAgentStatus()

	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		cancel()
		s.agentMu.Lock()
		if s.agentContext == ctx {
			s.agentStarting = false
		}
		s.agentMu.Unlock()
		return
	}
	s.workers.Add(1)
	s.workerMu.Unlock()
	go func() {
		defer s.workers.Done()
		onEvent := func(method string, params json.RawMessage) {
			if ctx.Err() == nil {
				s.handleAgentEvent(method, params)
			}
		}
		onTool := func(requestID json.RawMessage, params json.RawMessage) {
			if ctx.Err() == nil {
				s.handleAgentToolCall(requestID, params)
			}
		}
		onExit := func(err error) {
			if ctx.Err() == nil {
				s.handleAgentExit(err)
			}
		}
		var client agent.Runtime
		var status agent.Status
		var err error
		if mode == "apiKey" {
			apiClient, startErr := agent.NewAPIClient(ctx, config, onEvent, onTool)
			err = startErr
			if err == nil {
				client = apiClient
				status = agent.Status{State: "ready", Message: "API provider configured. Credentials are checked on the first request."}
			}
		} else {
			agentClient, startStatus, startErr := agent.StartCodex(ctx, config.MaxToolCalls, onEvent, onTool, onExit)
			status, err = startStatus, startErr
			if agentClient != nil {
				client = agentClient
			}
		}
		var models []agent.Model
		if err == nil && client != nil && status.State == "ready" {
			modelsContext, cancelModels := context.WithTimeout(ctx, agentOperationTimeout)
			var modelsErr error
			models, modelsErr = client.ListModels(modelsContext)
			cancelModels()
			if modelsErr != nil {
				status = agent.Status{State: "error", Message: fmt.Sprintf("Agent models could not be loaded: %v", modelsErr)}
				_ = client.Close()
				client = nil
			}
		}
		s.agentMu.Lock()
		if s.agentContext != ctx || ctx.Err() != nil {
			s.agentMu.Unlock()
			if client != nil {
				_ = client.Close()
			}
			return
		}
		s.agentStarting = false
		if err != nil {
			s.agentStatus = agent.Status{State: "error", Message: fmt.Sprintf("Agent could not start: %v", err)}
		} else {
			s.agentClient = client
			s.agentStatus = status
			s.agentModels = append([]agent.Model(nil), models...)
		}
		s.agentMu.Unlock()
		s.broadcastAgentStatus()
		s.broadcastAgentModels()
	}()
}

func (s *Server) retryAgentDetection() {
	s.closeAgent()
	s.agentMu.Lock()
	s.agentStatus = agent.Status{State: "checking", Message: "Preparing Agent connection…"}
	s.agentMu.Unlock()
	s.startAgentDetection()
}

func (s *Server) closeAgent() {
	s.cancelAgentRun("", "The Agent connection closed.")
	s.agentMu.Lock()
	client := s.agentClient
	cancel := s.agentCancel
	if cancel != nil {
		cancel()
	}
	s.agentClient = nil
	s.agentStarting = false
	s.agentCancel = nil
	s.agentContext = nil
	s.agentActiveThread = ""
	s.agentActiveTurn = ""
	s.agentToolRequests = make(map[string]json.RawMessage)
	s.agentModels = nil
	s.agentThreads = make(map[string]struct{})
	s.agentToolCallCount = 0
	s.agentMu.Unlock()
	if client != nil {
		_ = client.Close()
	}
}

func (s *Server) currentAgentStatus() agent.Status {
	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	return s.agentStatus
}

func (s *Server) currentAgentModels() []agent.Model {
	s.agentMu.Lock()
	defer s.agentMu.Unlock()
	return append([]agent.Model(nil), s.agentModels...)
}

func (s *Server) broadcastAgentStatus() {
	s.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "status", data: s.currentAgentStatus()})
}

func (s *Server) broadcastAgentModels() {
	s.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "models", data: s.currentAgentModels()})
}

func (s *Server) broadcastAgentRuntimeEvent(event cliRuntimeEvent) {
	s.agentEventMu.Lock()
	defer s.agentEventMu.Unlock()
	for subscriber := range s.agentSubscribers {
		select {
		case subscriber <- event:
		default:
			delete(s.agentSubscribers, subscriber)
			close(subscriber)
		}
	}
}

func (s *Server) closeAgentSubscribers() {
	s.agentEventMu.Lock()
	defer s.agentEventMu.Unlock()
	for subscriber := range s.agentSubscribers {
		delete(s.agentSubscribers, subscriber)
		close(subscriber)
	}
}

func (s *Server) handleAgentEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("streaming is unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	subscriber := make(chan cliRuntimeEvent, 64)
	s.agentEventMu.Lock()
	s.agentSubscribers[subscriber] = struct{}{}
	s.agentEventMu.Unlock()
	defer func() {
		s.agentEventMu.Lock()
		if _, exists := s.agentSubscribers[subscriber]; exists {
			delete(s.agentSubscribers, subscriber)
			close(subscriber)
		}
		s.agentEventMu.Unlock()
		// Reconnects recover the run snapshot. Claimed work is never replayed; its deadline is authoritative.
	}()

	if err := writeSSEEvent(w, cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"status": s.currentAgentStatus(),
		"models": s.currentAgentModels(),
		"runs":   s.currentAgentRuns(),
		"auth":   s.currentAgentAuth(),
	}}); err != nil {
		return
	}
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case event, open := <-subscriber:
			if !open || writeSSEEvent(w, event) != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

type agentPromptRequest struct {
	RunID           string      `json:"runId"`
	DocumentID      string      `json:"documentId"`
	ClientID        string      `json:"clientId"`
	Prompt          string      `json:"prompt"`
	ThreadID        string      `json:"threadId"`
	MainModel       string      `json:"mainModel"`
	FallbackHistory string      `json:"fallbackHistory"`
	Context         interface{} `json:"context"`
}

func (s *Server) handleAgentPrompt(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var request agentPromptRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid agent prompt request"))
		return
	}
	if err := s.startAgentPrompt(request); err != nil {
		writeAPIError(w, http.StatusConflict, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func resolveAgentModel(models []agent.Model, requestedMain string) (string, error) {
	if len(models) == 0 {
		return "", fmt.Errorf("The Agent has no available models")
	}
	find := func(requested string) string {
		requested = strings.TrimSpace(requested)
		for _, model := range models {
			if requested == model.Model || requested == model.ID {
				return model.Model
			}
		}
		return ""
	}
	mainModel := find(requestedMain)
	if strings.TrimSpace(requestedMain) != "" && mainModel == "" {
		return "", fmt.Errorf("the selected main Agent model is not available")
	}
	if mainModel == "" {
		mainModel = find("gpt-5.6-sol")
	}
	if mainModel == "" {
		for _, model := range models {
			if model.IsDefault {
				mainModel = model.Model
				break
			}
		}
	}
	if mainModel == "" {
		mainModel = models[0].Model
	}

	return mainModel, nil
}

func (s *Server) handleAgentCancel(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		RunID string `json:"runId"`
	}
	if json.NewDecoder(r.Body).Decode(&request) != nil || request.RunID == "" {
		writeAPIError(w, 400, fmt.Errorf("runId is required"))
		return
	}
	s.cancelAgentRun(request.RunID, "The user stopped the Kavla Agent.")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAgentRetry(w http.ResponseWriter, _ *http.Request) {
	s.retryAgentDetection()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) cancelAgentTurn(reason string) {
	s.cancelAgentRun("", reason)
}

type agentToolResultRequest struct {
	RunID    string      `json:"runId"`
	ClientID string      `json:"clientId"`
	CallID   string      `json:"callId"`
	Success  bool        `json:"success"`
	Result   interface{} `json:"result"`
	Error    string      `json:"error"`
}

func (s *Server) handleAgentToolResult(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var request agentToolResultRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid agent tool result request"))
		return
	}
	if err := s.acceptAgentToolResult(request); err != nil {
		writeAPIError(w, http.StatusConflict, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isAllowedAgentCanvasTool(tool string) bool {
	switch tool {
	case "get_canvas_context", "create_query", "run_query", "update_query", "create_chart", "create_note", "update_chart", "update_note", "compute_column_profiles", "create_summary", "create_lens", "update_lens", "move_shapes", "set_query_table":
		return true
	default:
		return false
	}
}

func (s *Server) handleAgentEvent(method string, params json.RawMessage) {
	var payload map[string]interface{}
	if json.Unmarshal(params, &payload) != nil {
		return
	}
	threadID, turnID := turnIdentity(payload)
	s.agentMu.Lock()
	run := s.agentRun
	if !activeAgentRun(run) || threadID != run.ThreadID || (run.TurnID != "" && turnID != "" && run.TurnID != turnID) {
		s.agentMu.Unlock()
		return
	}
	for _, previous := range s.agentHistory {
		if previous != run && turnID != "" && previous.ThreadID == threadID && previous.TurnID == turnID {
			s.agentMu.Unlock()
			return
		}
	}
	id := run.ID
	switch method {
	case "turn/started":
		run.TurnID = turnID
	case "item/reasoning/summaryTextDelta":
		itemID, _ := payload["itemId"].(string)
		index, _ := payload["summaryIndex"].(float64)
		delta, _ := payload["delta"].(string)
		thoughtID := fmt.Sprintf("%s:summary:%d", itemID, int(index))
		text := ""
		for _, thought := range run.Thoughts {
			if thought.ID == thoughtID {
				text = thought.Text
				break
			}
		}
		recordAgentThought(run, thoughtID, text+delta)
	case "item/agentMessage/delta":
		if delta, ok := payload["delta"].(string); ok {
			itemID, _ := payload["itemId"].(string)
			if itemID != "" && itemID != run.lastMessageID {
				recordAgentProgress(run)
				run.lastMessageID = itemID
				if run.messageIDs == nil {
					run.messageIDs = make(map[string]bool)
				}
				run.messageIDs[itemID] = true
			}
			run.Text += delta
		}
	case "item/completed":
		item, _ := payload["item"].(map[string]interface{})
		itemID, _ := item["id"].(string)
		if item["type"] == "reasoning" {
			// Only the provider's public summary belongs in chat, never raw reasoning content.
			if summary, ok := item["summary"].([]interface{}); ok {
				for index, part := range summary {
					if text, ok := part.(string); ok {
						recordAgentThought(run, fmt.Sprintf("%s:summary:%d", itemID, index), text)
					}
				}
			}
		}
		if item["type"] == "agentMessage" {
			text, _ := item["text"].(string)
			if item["phase"] == "commentary" {
				recordAgentThought(run, itemID, text)
				if run.lastMessageID == itemID {
					run.Text = ""
				}
			} else if itemID == run.lastMessageID || !run.messageIDs[itemID] {
				if itemID != run.lastMessageID {
					recordAgentProgress(run)
				}
				run.Text = text
				run.lastMessageID = itemID
			}
			if run.messageIDs == nil {
				run.messageIDs = make(map[string]bool)
			}
			run.messageIDs[itemID] = true
		}
	case "item/started":
		item, _ := payload["item"].(map[string]interface{})
		itemType, _ := item["type"].(string)
		if isForbiddenAgentItem(itemType) {
			s.agentMu.Unlock()
			go s.cancelAgentRun(id, "A non-canvas tool was blocked.")
			return
		}
	case "turn/completed":
		turn, _ := payload["turn"].(map[string]interface{})
		status, _ := turn["status"].(string)
		message := ""
		if status == "interrupted" {
			status, message = "cancelled", "Agent stopped."
		} else if status == "failed" {
			if failure, ok := turn["error"].(map[string]interface{}); ok {
				message, _ = failure["message"].(string)
			} else if text, ok := turn["error"].(string); ok {
				message = text
			}
			if message == "" {
				raw, _ := json.Marshal(turn["error"])
				message = string(raw)
			}
		} else {
			status = "completed"
		}
		s.agentMu.Unlock()
		s.finishAgentRun(id, status, message)
		return
	case "error":
		// Codex may retry a model request; the terminal turn event owns completion.
		run.Activity = "Codex reported an error; waiting for the turn outcome…"
	default:
		s.agentMu.Unlock()
		return
	}
	run.Revision++
	s.agentMu.Unlock()
	s.publishAgentRuns(method != "item/agentMessage/delta" && method != "item/reasoning/summaryTextDelta")
}

func (s *Server) handleAgentExit(processErr error) {
	s.agentMu.Lock()
	run := s.agentRun
	id := ""
	if run != nil {
		id = run.ID
	}
	s.agentMu.Unlock()
	s.finishAgentRun(id, "failed", "Codex stopped before the run finished.")
	s.agentMu.Lock()
	if s.agentClient == nil {
		s.agentMu.Unlock()
		return
	}
	s.agentClient = nil
	s.agentActiveThread = ""
	s.agentActiveTurn = ""
	message := "Codex App Server stopped. Retry the Agent to start it again."
	if processErr != nil {
		message = fmt.Sprintf("Codex App Server stopped: %v", processErr)
	}
	s.agentStatus = agent.Status{State: "error", Message: message}
	s.agentMu.Unlock()
	s.broadcastAgentStatus()
	s.sendAgentEvent("error", map[string]interface{}{"message": message})
}

func (s *Server) failAgentTurn(message string) {
	s.clearAgentActiveTurn()
	s.sendAgentEvent("error", map[string]interface{}{"message": message})
}

func (s *Server) clearAgentActiveTurn() {
	s.agentMu.Lock()
	s.agentActiveThread = ""
	s.agentActiveTurn = ""
	s.agentToolRequests = make(map[string]json.RawMessage)
	s.agentToolCallCount = 0
	s.agentMu.Unlock()
}

func (s *Server) sendAgentEvent(eventType string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	s.broadcastAgentRuntimeEvent(cliRuntimeEvent{
		name: "event",
		data: map[string]interface{}{
			"eventType": eventType,
			"data":      payload,
		},
	})
}

func turnIdentity(payload map[string]interface{}) (string, string) {
	turn, _ := payload["turn"].(map[string]interface{})
	threadID, _ := payload["threadId"].(string)
	if threadID == "" {
		threadID, _ = turn["threadId"].(string)
	}
	turnID, _ := payload["turnId"].(string)
	if turnID == "" {
		turnID, _ = turn["id"].(string)
	}
	return threadID, turnID
}

func isForbiddenAgentItem(itemType string) bool {
	switch itemType {
	case "commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageGeneration", "collabToolCall":
		return true
	default:
		return false
	}
}
