package localapp

import (
 "context"
 "crypto/sha256"
 "encoding/json"
 "errors"
 "fmt"
 "net/http"
 "os"
 "path/filepath"
 "strings"
 "time"

 "github.com/aleda145/kavla/cli/internal/agent"
)

const agentRunTimeout = 15 * time.Minute
const agentLensGenerationTimeout = 10 * time.Minute

type agentToolState struct {
 CallID string `json:"callId"`
 Tool string `json:"tool"`
 Arguments map[string]interface{} `json:"arguments"`
 Status string `json:"status"`
 Success bool `json:"success"`
 Result interface{} `json:"result,omitempty"`
 Error string `json:"error,omitempty"`
 StartedAt int64 `json:"startedAt"`
 RequestID json.RawMessage `json:"-"`
}

type agentRunState struct {
 Thoughts []agentThought `json:"thoughts,omitempty"`
 MaxToolCalls int `json:"maxToolCalls"`
 ID string `json:"id"`
 DocumentID string `json:"documentId"`
 ClientID string `json:"clientId"`
 ThreadID string `json:"threadId"`
 TurnID string `json:"turnId"`
 Model string `json:"model"`
 Status string `json:"status"`
 Prompt string `json:"prompt"`
 Text string `json:"text"`
 Error string `json:"error,omitempty"`
 Activity string `json:"activity"`
 CreatedAt int64 `json:"createdAt"`
 Revision int64 `json:"revision"`
 Tools []*agentToolState `json:"tools"`
 LensGenerations int `json:"lensGenerations,omitempty"`
 LensAttempts map[string]int `json:"lensAttempts,omitempty"`
 cancel context.CancelFunc
 ctx context.Context
 messageIDs map[string]bool
 lastMessageID string
}

type agentThought struct {
 ID string `json:"id"`
 Text string `json:"text"`
}

func recordAgentThought(run *agentRunState, id, text string) {
 if strings.TrimSpace(text) == "" { return }
 if id == "" { id = fmt.Sprintf("thought-%d", len(run.Thoughts)) }
 for i := range run.Thoughts {
  if run.Thoughts[i].ID == id { run.Thoughts[i].Text = text; return }
 }
 run.Thoughts = append(run.Thoughts, agentThought{ID: id, Text: text})
}

func recordAgentProgress(run *agentRunState) {
 recordAgentThought(run, run.lastMessageID, run.Text)
 run.Text = ""
}

func activeAgentRun(run *agentRunState) bool {
 return run != nil && (run.Status == "planning" || run.Status == "running" || run.Status == "waiting_for_tool")
}

func (s *Server) agentJournalPath() (string, error) {
 cache, err := os.UserCacheDir()
 if err != nil { return "", err }
 id := sha256.Sum256([]byte(s.document.Manifest().DocumentID))
 return filepath.Join(cache, "kavla", "agent", fmt.Sprintf("%x.json", id)), nil
}

func (s *Server) loadAgentRuns() error {
 s.agentJournalMu.Lock()
 defer s.agentJournalMu.Unlock()
 path, err := s.agentJournalPath()
 if err != nil { return err }
 var runs []*agentRunState
 data, err := os.ReadFile(path)
 if err != nil && !errors.Is(err, os.ErrNotExist) { return err }
 if len(data) > 0 {
  if err := json.Unmarshal(data, &runs); err != nil { return fmt.Errorf("read agent run journal: %w", err) }
 }
 for _, run := range runs {
  if activeAgentRun(run) {
   run.Status = "interrupted"
   run.Error = "Kavla stopped before this run completed. Send a follow-up to continue from the saved canvas."
   run.Activity = ""
   run.Revision++
   for _, tool := range run.Tools { if tool.Status == "pending" || tool.Status == "running" { tool.Status = "cancelled" } }
  }
 }
 s.agentMu.Lock()
 s.agentHistory = runs
 s.agentRun = nil
 s.agentMu.Unlock()
 return nil
}

func (s *Server) currentAgentRuns() json.RawMessage {
 s.agentMu.Lock()
 defer s.agentMu.Unlock()
 data, _ := json.Marshal(s.agentHistory)
 return data
}

func (s *Server) publishAgentRuns(persist bool) {
 // Serialize publication with journal writes so an older snapshot cannot overwrite a newer one.
 s.agentJournalMu.Lock()
 defer s.agentJournalMu.Unlock()
 data := s.currentAgentRuns()
 if persist {
  path, err := s.agentJournalPath()
  if err == nil { err = os.MkdirAll(filepath.Dir(path), 0700) }
  if err == nil { err = atomicWriteFile(path, data, 0600) }
  if err != nil { s.logCLIOutput("Could not save agent run history: %v\n", err) }
 }
 s.broadcastAgentRuntimeEvent(cliRuntimeEvent{name: "runs", data: data})
}

func (s *Server) finishAgentRun(id, status, message string) {
 s.agentMu.Lock()
 run := s.agentRun
 if !activeAgentRun(run) || run.ID != id { s.agentMu.Unlock(); return }
 run.Status, run.Error, run.Activity = status, message, ""
 run.Revision++
 if run.cancel != nil { run.cancel() }
 for _, tool := range run.Tools {
  if tool.Status == "pending" || tool.Status == "running" { tool.Status = "cancelled" }
 }
 s.agentActiveThread, s.agentActiveTurn = "", ""
 s.agentMu.Unlock()
 s.publishAgentRuns(true)
}

func (s *Server) startAgentPrompt(request agentPromptRequest) error {
 if strings.TrimSpace(request.Prompt) == "" || request.RunID == "" || request.ClientID == "" { return fmt.Errorf("prompt, runId, and clientId are required") }
 if request.DocumentID != s.document.Manifest().DocumentID { return fmt.Errorf("the canvas document has changed") }
 s.agentMu.Lock()
 for _, run := range s.agentHistory { if run.ID == request.RunID { s.agentMu.Unlock(); return nil } }
 client := s.agentClient
 if s.agentAuthChanging { s.agentMu.Unlock(); return fmt.Errorf("Agent authentication is changing; wait for it to reconnect") }
 if client == nil || s.agentStatus.State != "ready" { message := s.agentStatus.Message; s.agentMu.Unlock(); return fmt.Errorf("%s", message) }
 if activeAgentRun(s.agentRun) { s.agentMu.Unlock(); return fmt.Errorf("the Agent is already working; stop the current run first") }
 model, err := resolveAgentModel(s.agentModels, request.MainModel)
 if err != nil { s.agentMu.Unlock(); return err }
 ctx, cancel := context.WithTimeout(s.agentContext, agentRunTimeout)
 run := &agentRunState{ID: request.RunID, DocumentID: request.DocumentID, ClientID: request.ClientID, Model: model, Prompt: request.Prompt, Status: "planning", Activity: "Preparing analysis…", CreatedAt: time.Now().UnixMilli(), Revision: 1, Tools: []*agentToolState{}, ctx: ctx, cancel: cancel}
 run.MaxToolCalls = s.apiProviderLocked().MaxToolCalls
 s.agentRun = run
 s.agentHistory = append(s.agentHistory, run)
 if len(s.agentHistory) > 30 { s.agentHistory = s.agentHistory[len(s.agentHistory)-30:] }
 s.agentMu.Unlock()
 s.publishAgentRuns(true)
 s.workerMu.Lock()
 if s.closing { s.workerMu.Unlock(); s.finishAgentRun(run.ID, "cancelled", "Kavla is closing."); return fmt.Errorf("Kavla is closing") }
 s.workers.Add(1)
 s.workerMu.Unlock()
 go func() {
  defer s.workers.Done()
  defer func() { <-ctx.Done(); if ctx.Err() == context.DeadlineExceeded { s.cancelAgentRun(run.ID, "Agent run exceeded its 15-minute limit. Existing canvas work has been kept.") } }()
  if ctx.Err() != nil { return }
  operationContext, cancelOperation := context.WithTimeout(ctx, agentOperationTimeout)
  defer cancelOperation()
  threadID, resumed, err := client.StartOrResumeThread(operationContext, request.ThreadID, model)
  if err != nil { s.finishAgentRun(run.ID, "failed", err.Error()); return }
  history := ""
  if !resumed { history = request.FallbackHistory }
  prompt, err := agent.BuildPrompt(request.Prompt, request.Context, history)
  if err != nil { s.finishAgentRun(run.ID, "failed", err.Error()); return }
  s.agentMu.Lock()
  if !activeAgentRun(run) || s.agentRun != run { s.agentMu.Unlock(); return }
  run.ThreadID, run.Status, run.Activity = threadID, "running", "Thinking…"
  run.Revision++
  s.agentActiveThread, s.agentActiveTurn = threadID, "starting"
  s.agentMu.Unlock()
  s.publishAgentRuns(true)
  turnID, err := client.StartTurn(operationContext, threadID, prompt)
  if err != nil { s.finishAgentRun(run.ID, "failed", err.Error()); return }
  s.agentMu.Lock()
  stillActive := s.agentRun == run && activeAgentRun(run)
  if stillActive { run.TurnID = turnID; run.Revision++; s.agentActiveTurn = turnID }
  s.agentMu.Unlock()
  if !stillActive {
   interruptContext, cancelInterrupt := context.WithTimeout(context.Background(), 5*time.Second)
   defer cancelInterrupt()
   _ = client.InterruptTurn(interruptContext, threadID, turnID)
   return
  }
  s.publishAgentRuns(true)
 }()
 return nil
}

func (s *Server) cancelAgentRun(id, reason string) {
 s.stopAgentRun(id, "cancelled", reason)
}

func (s *Server) stopAgentRun(id, status, reason string) {
 s.agentMu.Lock()
 run, client := s.agentRun, s.agentClient
 if !activeAgentRun(run) || (id != "" && run.ID != id) { s.agentMu.Unlock(); return }
 runID, threadID, turnID := run.ID, run.ThreadID, run.TurnID
 s.agentMu.Unlock()
 s.finishAgentRun(runID, status, reason)
 if client != nil && threadID != "" && turnID != "" {
  ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
  defer cancel()
  if err := client.InterruptTurn(ctx, threadID, turnID); err != nil { s.logCLIOutput("Could not interrupt agent: %v\n", err) }
 }
}

func (s *Server) handleAgentToolCall(requestID json.RawMessage, params json.RawMessage) {
 var request struct { Arguments map[string]interface{} `json:"arguments"`; CallID string `json:"callId"`; Namespace string `json:"namespace"`; ThreadID string `json:"threadId"`; Tool string `json:"tool"`; TurnID string `json:"turnId"` }
 err := json.Unmarshal(params, &request)
 s.agentMu.Lock()
 run, client := s.agentRun, s.agentClient
 reject := ""
 if err != nil || request.CallID == "" { reject = "Invalid canvas tool call." } else if !activeAgentRun(run) || run.ThreadID != request.ThreadID || (run.TurnID != "" && run.TurnID != request.TurnID) { reject = "This agent run is no longer active." } else if (request.Namespace != "" && request.Namespace != "kavla") || !isAllowedAgentCanvasTool(request.Tool) { reject = "Only Kavla canvas tools are available." }
 if reject == "" {
  for _, previous := range run.Tools {
   if previous.CallID == request.CallID {
    result, success, status := previous.Result, previous.Success, previous.Status
    s.agentMu.Unlock()
    if client != nil && status == "completed" { _ = client.RespondToTool(requestID, success, result) }
    return
   }
  }
  if len(run.Tools) >= agent.MaxToolCallsOrDefault(run.MaxToolCalls) { reject = "The run has reached its tool budget. Finish with the best available evidence." }
 }
 if reject != "" { s.agentMu.Unlock(); if client != nil { _ = client.RespondToTool(requestID, false, map[string]string{"error": reject}) }; return }
 call := &agentToolState{CallID: request.CallID, Tool: request.Tool, Arguments: request.Arguments, Status: "pending", StartedAt: time.Now().UnixMilli(), RequestID: append(json.RawMessage(nil), requestID...)}
 recordAgentProgress(run)
 if progress, ok := request.Arguments["progress"].(string); ok { recordAgentThought(run, "tool:" + request.CallID, progress) }
 run.Tools = append(run.Tools, call)
 run.Status, run.Activity = "waiting_for_tool", "Using " + strings.ReplaceAll(request.Tool, "_", " ") + "…"
 run.Revision++
 runID, ctx := run.ID, run.ctx
 s.agentMu.Unlock()
 s.publishAgentRuns(true)
 // Lens generation and a possible repair share the remaining overall run budget.
 // The ordinary eight-minute tool limit would otherwise cut off a valid Lens request.
 if request.Tool == "create_lens" || request.Tool == "update_lens" { return }
 go func() {
  timer := time.NewTimer(8*time.Minute)
  defer timer.Stop()
  select {
  case <-ctx.Done(): return
  case <-timer.C:
   s.agentMu.Lock()
   pending := s.agentRun == run && activeAgentRun(run) && (call.Status == "pending" || call.Status == "running")
   s.agentMu.Unlock()
   if pending { s.cancelAgentRun(runID, "A canvas tool timed out. The existing canvas work has been kept.") }
  }
 }()
}

type agentClaimRequest struct { RunID string `json:"runId"`; ClientID string `json:"clientId"`; CallID string `json:"callId"` }

func (s *Server) handleAgentToolClaim(w http.ResponseWriter, r *http.Request) {
 r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
 var request agentClaimRequest
 if json.NewDecoder(r.Body).Decode(&request) != nil { writeAPIError(w, 400, fmt.Errorf("invalid claim")); return }
 s.agentMu.Lock()
 run := s.agentRun
 claimed := false
 if activeAgentRun(run) && run.ID == request.RunID && run.ClientID == request.ClientID {
  for _, call := range run.Tools { if call.CallID == request.CallID && call.Status == "pending" { call.Status = "running"; run.Revision++; claimed = true; break } }
 }
 s.agentMu.Unlock()
 if claimed { s.publishAgentRuns(true) }
 w.Header().Set("Content-Type", "application/json")
 _ = json.NewEncoder(w).Encode(map[string]bool{"claimed": claimed})
}

func (s *Server) acceptAgentToolResult(request agentToolResultRequest) error {
 s.agentMu.Lock()
 run, client := s.agentRun, s.agentClient
 if !activeAgentRun(run) || run.ID != request.RunID || run.ClientID != request.ClientID || client == nil { s.agentMu.Unlock(); return fmt.Errorf("this agent run is no longer active") }
 var call *agentToolState
 for _, candidate := range run.Tools { if candidate.CallID == request.CallID { call = candidate; break } }
 if call == nil { s.agentMu.Unlock(); return fmt.Errorf("unknown tool call") }
 if call.Status == "completed" { s.agentMu.Unlock(); return nil }
 if call.Status != "running" { s.agentMu.Unlock(); return fmt.Errorf("tool call must be claimed before returning a result") }
 value := request.Result
 if !request.Success && value == nil { value = map[string]interface{}{"error": request.Error} }
 call.Result, call.Success, call.Error, call.Status = value, request.Success, request.Error, "completed"
 run.Status, run.Activity = "running", "Thinking…"
 run.Revision++
 requestID := call.RequestID
 s.agentMu.Unlock()
 s.publishAgentRuns(true)
 if err := client.RespondToTool(requestID, request.Success, value); err != nil { s.finishAgentRun(run.ID, "failed", err.Error()); return err }
 if result, ok := value.(map[string]interface{}); ok && !request.Success && result["stopRun"] == true {
  s.stopAgentRun(run.ID, "failed", request.Error)
 }
 return nil
}

func (s *Server) handleAgentGenerateLens(w http.ResponseWriter, r *http.Request) {
 r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
 var request struct { RunID string `json:"runId"`; ClientID string `json:"clientId"`; Prompt string `json:"prompt"`; Context interface{} `json:"context"` }
 if json.NewDecoder(r.Body).Decode(&request) != nil { writeAPIError(w, 400, fmt.Errorf("invalid generation request")); return }
 s.agentMu.Lock()
 run, client := s.agentRun, s.agentClient
 if !activeAgentRun(run) || run.ID != request.RunID || run.ClientID != request.ClientID || client == nil { s.agentMu.Unlock(); writeAPIError(w, 409, fmt.Errorf("this agent run is no longer active")); return }
 target := "lens"
 if supplied, ok := request.Context.(map[string]interface{}); ok {
  if id, ok := supplied["targetShapeId"].(string); ok && id != "" { target = id }
 }
 if run.LensAttempts == nil { run.LensAttempts = make(map[string]int) }
 if run.LensGenerations >= 4 || run.LensAttempts[target] >= 2 {
  s.agentMu.Unlock()
  writeAPIError(w, 409, fmt.Errorf("Lens generation budget exhausted. Stop and show the existing error; another user request is required to retry."))
  return
 }
 run.LensGenerations++
 run.LensAttempts[target]++
 parent, model := run.ctx, run.Model
 run.Activity = "Generating Lens…"; run.Revision++
 s.agentMu.Unlock()
 s.publishAgentRuns(true)
 ctx, cancel := context.WithTimeout(parent, agentLensGenerationTimeout)
 stop := context.AfterFunc(r.Context(), cancel)
 defer stop(); defer cancel()
 result, err := client.GenerateLens(ctx, model, request.Prompt, request.Context)
 if err != nil {
  if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
   message := fmt.Errorf("Lens generation exceeded its %d-minute limit. Existing canvas work has been kept.", int(agentLensGenerationTimeout/time.Minute))
   if parent.Err() == context.DeadlineExceeded { message = fmt.Errorf("Agent run exceeded its 15-minute limit during Lens generation. Existing canvas work has been kept.") }
   writeAPIError(w, http.StatusGatewayTimeout, message)
   return
  }
  writeAPIError(w, 500, err); return
 }
 w.Header().Set("Content-Type", "application/json")
 _ = json.NewEncoder(w).Encode(result)
}
