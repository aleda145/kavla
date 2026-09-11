package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
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
		lastSubscriber := len(s.codexSubscribers) == 0
		s.codexEventMu.Unlock()
		if lastSubscriber {
			s.cancelCodexTurn("The Kavla editor disconnected.")
		}
	}()

	if err := writeSSEEvent(w, cliRuntimeEvent{name: "snapshot", data: map[string]interface{}{
		"status": s.currentCodexStatus(),
		"models": s.currentCodexModels(),
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

func (s *Server) startCodexPrompt(request codexPromptRequest) error {
	prompt := strings.TrimSpace(request.Prompt)
	if prompt == "" {
		return fmt.Errorf("Codex prompt is required")
	}
	canvasContext := request.Context
	if canvasContext == nil {
		canvasContext = map[string]interface{}{}
	}

	s.codexMu.Lock()
	client := s.codexClient
	status := s.codexStatus
	mainModel, layoutModel, modelErr := resolveCodexModels(s.codexModels, request.MainModel, request.LayoutModel)
	resumeThreadID := ""
	if _, known := s.codexThreads[strings.TrimSpace(request.ThreadID)]; known {
		resumeThreadID = strings.TrimSpace(request.ThreadID)
	}
	operationParent := s.codexContext
	if client == nil || status.State != "ready" {
		s.codexMu.Unlock()
		return fmt.Errorf("%s", status.Message)
	}
	if modelErr != nil {
		s.codexMu.Unlock()
		return modelErr
	}
	if s.codexActiveTurn != "" {
		s.codexMu.Unlock()
		return fmt.Errorf("the Kavla Agent is already working")
	}
	if operationParent == nil {
		s.codexMu.Unlock()
		return fmt.Errorf("the Kavla Agent is not running")
	}
	s.codexActiveTurn = "starting"
	s.codexToolCallCount = 0
	s.codexMu.Unlock()

	s.workerMu.Lock()
	if s.closing {
		s.workerMu.Unlock()
		s.clearCodexActiveTurn()
		return fmt.Errorf("Kavla is closing")
	}
	s.workers.Add(1)
	s.workerMu.Unlock()
	go func() {
		defer s.workers.Done()
		operationContext, cancel := context.WithTimeout(operationParent, codexOperationTimeout)
		defer cancel()

		s.sendCodexEvent("layout_started", map[string]interface{}{"model": layoutModel})
		layoutPlan, err := client.PlanLayout(operationContext, layoutModel, prompt, canvasContext)
		if err != nil {
			if operationParent.Err() == nil {
				s.failCodexTurn(fmt.Sprintf("Layout planning failed: %v", err))
			}
			return
		}

		resolvedThreadID, resumed, err := client.StartOrResumeThread(operationContext, resumeThreadID, mainModel)
		if err != nil {
			if operationParent.Err() == nil {
				s.failCodexTurn(fmt.Sprintf("Codex conversation could not start: %v", err))
			}
			return
		}
		history := ""
		if !resumed {
			history = request.FallbackHistory
		}
		fullPrompt, err := codex.BuildPrompt(prompt, canvasContext, history, layoutPlan)
		if err != nil {
			s.failCodexTurn(err.Error())
			return
		}
		s.codexMu.Lock()
		if s.codexClient != client || operationParent.Err() != nil {
			s.codexMu.Unlock()
			return
		}
		s.codexActiveThread = resolvedThreadID
		s.codexThreads[resolvedThreadID] = struct{}{}
		s.codexMu.Unlock()
		s.broadcastCodexRuntimeEvent(cliRuntimeEvent{
			name: "thread",
			data: map[string]interface{}{
				"threadId": resolvedThreadID,
				"resumed":  resumed,
				"model":    mainModel,
			},
		})
		turnID, err := client.StartTurn(operationContext, resolvedThreadID, fullPrompt)
		if err != nil {
			if operationParent.Err() == nil {
				s.failCodexTurn(err.Error())
			}
			return
		}
		s.codexMu.Lock()
		if s.codexClient != client || operationParent.Err() != nil || s.codexActiveTurn != "starting" {
			s.codexMu.Unlock()
			return
		}
		s.codexActiveThread = resolvedThreadID
		s.codexActiveTurn = turnID
		s.codexMu.Unlock()
		s.sendCodexEvent("started", map[string]interface{}{
			"threadId": resolvedThreadID,
			"turnId":   turnID,
		})
	}()
	return nil
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

func (s *Server) handleCodexCancel(w http.ResponseWriter, _ *http.Request) {
	s.cancelCodexTurn("The user stopped the Kavla Agent.")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCodexRetry(w http.ResponseWriter, _ *http.Request) {
	s.retryCodexDetection()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) cancelCodexTurn(reason string) {
	s.codexMu.Lock()
	client := s.codexClient
	threadID := s.codexActiveThread
	turnID := s.codexActiveTurn
	s.codexMu.Unlock()
	if turnID == "starting" {
		s.retryCodexDetection()
		s.sendCodexEvent("cancelled", map[string]interface{}{"message": reason})
		return
	}
	if client == nil || threadID == "" || turnID == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := client.InterruptTurn(ctx, threadID, turnID); err != nil {
			log.Printf("interrupt Codex turn: %v", err)
		}
		// Completion is reported by Codex's turn/completed event.
	}()
}

type codexToolResultRequest struct {
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

func (s *Server) acceptCodexToolResult(request codexToolResultRequest) error {
	callID := strings.TrimSpace(request.CallID)
	if callID == "" {
		return fmt.Errorf("Codex tool call id is required")
	}
	value := request.Result
	if !request.Success {
		value = map[string]interface{}{"error": request.Error}
	}

	s.codexMu.Lock()
	requestID := s.codexToolRequests[callID]
	delete(s.codexToolRequests, callID)
	client := s.codexClient
	s.codexMu.Unlock()
	if len(requestID) == 0 || client == nil {
		return fmt.Errorf("Codex tool call %q is no longer active", callID)
	}
	if err := client.RespondToTool(requestID, request.Success, value); err != nil {
		return fmt.Errorf("return Kavla tool result to Codex: %w", err)
	}
	return nil
}

func (s *Server) handleCodexToolCall(requestID json.RawMessage, params json.RawMessage) {
	var request struct {
		Arguments interface{} `json:"arguments"`
		CallID    string      `json:"callId"`
		Namespace string      `json:"namespace"`
		ThreadID  string      `json:"threadId"`
		Tool      string      `json:"tool"`
		TurnID    string      `json:"turnId"`
	}
	if err := json.Unmarshal(params, &request); err != nil || strings.TrimSpace(request.CallID) == "" {
		s.codexMu.Lock()
		client := s.codexClient
		s.codexMu.Unlock()
		if client != nil {
			_ = client.RespondToTool(requestID, false, map[string]string{"error": "Codex sent an invalid Kavla tool call."})
		}
		return
	}
	if request.Namespace != "" && request.Namespace != "kavla" {
		s.codexMu.Lock()
		client := s.codexClient
		s.codexMu.Unlock()
		if client != nil {
			_ = client.RespondToTool(requestID, false, map[string]string{"error": "Only Kavla canvas tools are available."})
		}
		return
	}
	if !isAllowedCodexCanvasTool(request.Tool) {
		s.codexMu.Lock()
		client := s.codexClient
		s.codexMu.Unlock()
		if client != nil {
			_ = client.RespondToTool(requestID, false, map[string]string{
				"error": "This Kavla tool is unavailable. Every SQL execution must use a visible create_query or update_query shape.",
			})
		}
		return
	}
	s.codexMu.Lock()
	if s.codexToolCallCount >= 4 {
		client := s.codexClient
		s.codexMu.Unlock()
		if client != nil {
			_ = client.RespondToTool(requestID, false, map[string]string{
				"error": "This turn has reached its four-tool canvas budget. Answer from the best successful visible evidence or explain what remains.",
			})
		}
		return
	}
	s.codexToolCallCount++
	s.codexMu.Unlock()

	s.codexMu.Lock()
	s.codexToolRequests[request.CallID] = append(json.RawMessage(nil), requestID...)
	s.codexMu.Unlock()
	s.broadcastCodexRuntimeEvent(cliRuntimeEvent{
		name: "tool_request",
		data: map[string]interface{}{
			"arguments": request.Arguments,
			"callId":    request.CallID,
			"threadId":  request.ThreadID,
			"tool":      request.Tool,
			"turnId":    request.TurnID,
		},
	})
}

func isAllowedCodexCanvasTool(tool string) bool {
	switch tool {
	case "get_canvas_context", "create_query", "run_query", "update_query", "create_chart", "create_note":
		return true
	default:
		return false
	}
}

func (s *Server) handleCodexEvent(method string, params json.RawMessage) {
	var payload map[string]interface{}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &payload)
	}
	switch method {
	case "item/agentMessage/delta":
		s.sendCodexEvent("message_delta", payload)
	case "turn/started":
		threadID, turnID := turnIdentity(payload)
		if threadID != "" || turnID != "" {
			s.codexMu.Lock()
			if threadID != "" {
				s.codexActiveThread = threadID
			}
			if turnID != "" {
				s.codexActiveTurn = turnID
			}
			s.codexMu.Unlock()
		}
		s.sendCodexEvent("started", payload)
	case "turn/completed":
		s.clearCodexActiveTurn()
		turn, _ := payload["turn"].(map[string]interface{})
		status, _ := turn["status"].(string)
		switch status {
		case "interrupted":
			s.sendCodexEvent("cancelled", map[string]interface{}{"message": "Agent stopped."})
		case "failed":
			s.sendCodexEvent("error", map[string]interface{}{"error": turn["error"]})
		default:
			s.sendCodexEvent("completed", payload)
		}
	case "item/started":
		item, _ := payload["item"].(map[string]interface{})
		itemType, _ := item["type"].(string)
		if isForbiddenCodexItem(itemType) {
			s.cancelCodexTurn("A non-canvas tool was blocked.")
			s.failCodexTurn("Codex attempted to use a non-canvas tool. The turn was stopped.")
			return
		}
		if itemType == "dynamicToolCall" {
			s.sendCodexEvent("tool_started", payload)
		}
	case "item/completed":
		item, _ := payload["item"].(map[string]interface{})
		if itemType, _ := item["type"].(string); itemType == "dynamicToolCall" {
			s.sendCodexEvent("tool_finished", payload)
		}
	case "error":
		s.sendCodexEvent("error", payload)
	case "warning", "configWarning":
		s.sendCodexEvent("warning", payload)
	}
}

func (s *Server) handleCodexExit(processErr error) {
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
