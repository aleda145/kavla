package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aleda145/kavla/cli/internal/codex"
)

const codexOperationTimeout = 45 * time.Second

func (s *Server) startCodexDetection() {
	s.codexMu.Lock()
	if s.codexStarting || s.codexClient != nil {
		s.codexMu.Unlock()
		return
	}
	s.codexStarting = true
	s.codexStatus = codex.Status{State: "checking", Message: "Checking for Codex CLI…"}
	ctx, cancel := context.WithCancel(context.Background())
	s.codexContext = ctx
	s.codexCancel = cancel
	s.codexMu.Unlock()
	s.broadcastCodexStatus()

	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		cancel()
		s.codexMu.Lock()
		if s.codexContext == ctx {
			s.codexStarting = false
		}
		s.codexMu.Unlock()
		return
	}
	s.workers.Add(1)
	s.workerMu.Unlock()
	go func() {
		defer s.workers.Done()
		client, status, err := codex.Start(ctx,
			func(method string, params json.RawMessage) {
				if ctx.Err() == nil {
					s.handleCodexEvent(method, params)
				}
			},
			func(requestID json.RawMessage, params json.RawMessage) {
				if ctx.Err() == nil {
					s.handleCodexToolCall(requestID, params)
				}
			},
			func(err error) {
				if ctx.Err() == nil {
					s.handleCodexExit(err)
				}
			},
		)
		var models []codex.Model
		if err == nil && client != nil && status.State == "ready" {
			modelsContext, cancelModels := context.WithTimeout(ctx, codexOperationTimeout)
			var modelsErr error
			models, modelsErr = client.ListModels(modelsContext)
			cancelModels()
			if modelsErr != nil {
				status = codex.Status{State: "error", Message: fmt.Sprintf("Codex models could not be loaded: %v", modelsErr)}
				_ = client.Close()
				client = nil
			}
		}
		s.codexMu.Lock()
		if s.codexContext != ctx || ctx.Err() != nil {
			s.codexMu.Unlock()
			if client != nil {
				_ = client.Close()
			}
			return
		}
		s.codexStarting = false
		if err != nil {
			s.codexStatus = codex.Status{State: "error", Message: fmt.Sprintf("Codex could not start: %v", err)}
		} else {
			s.codexClient = client
			s.codexStatus = status
			s.codexModels = append([]codex.Model(nil), models...)
		}
		s.codexMu.Unlock()
		s.broadcastCodexStatus()
		s.broadcastCodexModels()
	}()
}

func (s *Server) retryCodexDetection() {
	s.closeCodex()
	s.codexMu.Lock()
	s.codexStatus = codex.Status{State: "checking", Message: "Checking for Codex CLI…"}
	s.codexMu.Unlock()
	s.startCodexDetection()
}

func (s *Server) closeCodex() {
 s.cancelCodexRun("", "The Codex connection closed.")
	s.codexMu.Lock()
	client := s.codexClient
	cancel := s.codexCancel
	if cancel != nil {
		cancel()
	}
	s.codexClient = nil
	s.codexStarting = false
	s.codexCancel = nil
	s.codexContext = nil
	s.codexActiveThread = ""
	s.codexActiveTurn = ""
	s.codexToolRequests = make(map[string]json.RawMessage)
	s.codexModels = nil
	s.codexThreads = make(map[string]struct{})
	s.codexToolCallCount = 0
	s.codexMu.Unlock()
	if client != nil {
		_ = client.Close()
	}
}

func (s *Server) currentCodexStatus() codex.Status {
	s.codexMu.Lock()
	defer s.codexMu.Unlock()
	return s.codexStatus
}

func (s *Server) currentCodexModels() []codex.Model {
	s.codexMu.Lock()
	defer s.codexMu.Unlock()
	return append([]codex.Model(nil), s.codexModels...)
}

func (s *Server) broadcastCodexStatus() {
	s.broadcastCodexRuntimeEvent(cliRuntimeEvent{name: "status", data: s.currentCodexStatus()})
}

func (s *Server) broadcastCodexModels() {
	s.broadcastCodexRuntimeEvent(cliRuntimeEvent{name: "models", data: s.currentCodexModels()})
}

func (s *Server) broadcastCodexRuntimeEvent(event cliRuntimeEvent) {
	s.codexEventMu.Lock()
	defer s.codexEventMu.Unlock()
	for subscriber := range s.codexSubscribers {
		select {
		case subscriber <- event:
		default:
			delete(s.codexSubscribers, subscriber)
			close(subscriber)
		}
	}
}

func (s *Server) closeCodexSubscribers() {
	s.codexEventMu.Lock()
	defer s.codexEventMu.Unlock()
	for subscriber := range s.codexSubscribers {
		delete(s.codexSubscribers, subscriber)
		close(subscriber)
	}
}

func (s *Server) handleCodexEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, fmt.Errorf("streaming is unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	subscriber := make(chan cliRuntimeEvent, 64)
	s.codexEventMu.Lock()
	s.codexSubscribers[subscriber] = struct{}{}
	s.codexEventMu.Unlock()
	defer func() {
		s.codexEventMu.Lock()
		if _, exists := s.codexSubscribers[subscriber]; exists {
			delete(s.codexSubscribers, subscriber)
			close(subscriber)
		}
		s.codexEventMu.Unlock()
        // Reconnects recover the run snapshot. Claimed work is never replayed; its deadline is authoritative.
	}()

	if err := writeSSEEvent(w, cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"status": s.currentCodexStatus(),
		"models": s.currentCodexModels(),
  "runs": s.currentCodexRuns(),
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

type codexPromptRequest struct {
 RunID string `json:"runId"`
 DocumentID string `json:"documentId"`
 ClientID string `json:"clientId"`
 PlanLayout bool `json:"planLayout"`
	Prompt          string      `json:"prompt"`
	ThreadID        string      `json:"threadId"`
	MainModel       string      `json:"mainModel"`
	LayoutModel     string      `json:"layoutModel"`
	FallbackHistory string      `json:"fallbackHistory"`
	Context         interface{} `json:"context"`
}

func (s *Server) handleCodexPrompt(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var request codexPromptRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid Codex prompt request"))
		return
	}
	if err := s.startCodexPrompt(request); err != nil {
		writeAPIError(w, http.StatusConflict, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func resolveCodexModels(models []codex.Model, requestedMain, requestedLayout string) (string, string, error) {
	if len(models) == 0 {
		return "", "", fmt.Errorf("Codex has no available models")
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
		return "", "", fmt.Errorf("the selected main Codex model is not available")
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

	layoutModel := find(requestedLayout)
	if strings.TrimSpace(requestedLayout) != "" && layoutModel == "" {
		return "", "", fmt.Errorf("the selected layout Codex model is not available")
	}
	if layoutModel == "" {
		layoutModel = find("gpt-5.6-terra")
	}
	if layoutModel == "" {
		layoutModel = mainModel
	}
	return mainModel, layoutModel, nil
}

func (s *Server) handleCodexCancel(w http.ResponseWriter, r *http.Request) {
 r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
 var request struct { RunID string `json:"runId"` }
 if json.NewDecoder(r.Body).Decode(&request) != nil || request.RunID == "" { writeAPIError(w, 400, fmt.Errorf("runId is required")); return }
 s.cancelCodexRun(request.RunID, "The user stopped the Kavla Agent.")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCodexRetry(w http.ResponseWriter, _ *http.Request) {
	s.retryCodexDetection()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) cancelCodexTurn(reason string) {
 s.cancelCodexRun("", reason)
}

type codexToolResultRequest struct {
 RunID string `json:"runId"`
 ClientID string `json:"clientId"`
	CallID  string      `json:"callId"`
	Success bool        `json:"success"`
	Result  interface{} `json:"result"`
	Error   string      `json:"error"`
}

func (s *Server) handleCodexToolResult(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	var request codexToolResultRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid Codex tool result request"))
		return
	}
	if err := s.acceptCodexToolResult(request); err != nil {
		writeAPIError(w, http.StatusConflict, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isAllowedCodexCanvasTool(tool string) bool {
	switch tool {
	case "get_canvas_context", "create_query", "run_query", "update_query", "create_chart", "create_note", "update_chart", "update_note", "compute_column_profiles", "create_analysis_query", "edit_query", "create_summary", "create_lens", "update_lens":
		return true
	default:
		return false
	}
}

func (s *Server) handleCodexEvent(method string, params json.RawMessage) {
 var payload map[string]interface{}
 if json.Unmarshal(params, &payload) != nil { return }
 threadID, turnID := turnIdentity(payload)
 s.codexMu.Lock()
 run := s.codexRun
 if !activeCodexRun(run) || threadID != run.ThreadID || (run.TurnID != "" && turnID != "" && run.TurnID != turnID) { s.codexMu.Unlock(); return }
 for _, previous := range s.codexHistory {
  if previous != run && turnID != "" && previous.ThreadID == threadID && previous.TurnID == turnID { s.codexMu.Unlock(); return }
 }
 id := run.ID
 switch method {
 case "turn/started":
  run.TurnID = turnID
 case "item/agentMessage/delta":
  if delta, ok := payload["delta"].(string); ok {
   itemID, _ := payload["itemId"].(string)
   if itemID != "" && itemID != run.lastMessageID {
    if run.Text != "" { run.Text += "\n\n" }
    run.lastMessageID = itemID
    if run.messageIDs == nil { run.messageIDs = make(map[string]bool) }
    run.messageIDs[itemID] = true
   }
   run.Text += delta
  }
 case "item/completed":
  item, _ := payload["item"].(map[string]interface{})
  itemID, _ := item["id"].(string)
  if item["type"] == "agentMessage" && ((itemID != "" && !run.messageIDs[itemID]) || run.Text == "") {
   text, _ := item["text"].(string)
   if run.Text != "" && text != "" { run.Text += "\n\n" }
   run.Text += text
   if run.messageIDs == nil { run.messageIDs = make(map[string]bool) }
   run.messageIDs[itemID] = true
  }
 case "item/started":
  item, _ := payload["item"].(map[string]interface{})
  itemType, _ := item["type"].(string)
  if isForbiddenCodexItem(itemType) { s.codexMu.Unlock(); go s.cancelCodexRun(id, "A non-canvas tool was blocked."); return }
 case "turn/completed":
  turn, _ := payload["turn"].(map[string]interface{})
  status, _ := turn["status"].(string)
  message := ""
  if status == "interrupted" { status, message = "cancelled", "Agent stopped." } else if status == "failed" {
   raw, _ := json.Marshal(turn["error"]); message = string(raw)
  } else { status = "completed" }
  s.codexMu.Unlock(); s.finishCodexRun(id, status, message); return
 case "error":
  // Codex may retry a model request; the terminal turn event owns completion.
  run.Activity = "Codex reported an error; waiting for the turn outcome…"
 default:
  s.codexMu.Unlock(); return
 }
 run.Revision++
 s.codexMu.Unlock()
 s.publishCodexRuns(method != "item/agentMessage/delta")
}

func (s *Server) handleCodexExit(processErr error) {
 s.codexMu.Lock()
 run := s.codexRun
 id := ""
 if run != nil { id = run.ID }
 s.codexMu.Unlock()
 s.finishCodexRun(id, "failed", "Codex stopped before the run finished.")
	s.codexMu.Lock()
	if s.codexClient == nil {
		s.codexMu.Unlock()
		return
	}
	s.codexClient = nil
	s.codexActiveThread = ""
	s.codexActiveTurn = ""
	message := "Codex App Server stopped. Retry the Agent to start it again."
	if processErr != nil {
		message = fmt.Sprintf("Codex App Server stopped: %v", processErr)
	}
	s.codexStatus = codex.Status{State: "error", Message: message}
	s.codexMu.Unlock()
	s.broadcastCodexStatus()
	s.sendCodexEvent("error", map[string]interface{}{"message": message})
}

func (s *Server) failCodexTurn(message string) {
	s.clearCodexActiveTurn()
	s.sendCodexEvent("error", map[string]interface{}{"message": message})
}

func (s *Server) clearCodexActiveTurn() {
	s.codexMu.Lock()
	s.codexActiveThread = ""
	s.codexActiveTurn = ""
	s.codexToolRequests = make(map[string]json.RawMessage)
	s.codexToolCallCount = 0
	s.codexMu.Unlock()
}

func (s *Server) sendCodexEvent(eventType string, payload map[string]interface{}) {
	if payload == nil {
		payload = map[string]interface{}{}
	}
	s.broadcastCodexRuntimeEvent(cliRuntimeEvent{
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

func isForbiddenCodexItem(itemType string) bool {
	switch itemType {
	case "commandExecution", "fileChange", "mcpToolCall", "webSearch", "imageGeneration", "collabToolCall":
		return true
	default:
		return false
	}
}
