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

 "github.com/aleda145/kavla/cli/internal/codex"
)

type codexToolState struct {
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

type codexRunState struct {
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
 Tools []*codexToolState `json:"tools"`
 cancel context.CancelFunc
 ctx context.Context
 messageIDs map[string]bool
 lastMessageID string
}

func activeCodexRun(run *codexRunState) bool {
 return run != nil && (run.Status == "planning" || run.Status == "running" || run.Status == "waiting_for_tool")
}

func (s *Server) codexJournalPath() (string, error) {
 cache, err := os.UserCacheDir()
 if err != nil { return "", err }
 id := sha256.Sum256([]byte(s.document.Manifest().DocumentID))
 return filepath.Join(cache, "kavla", "agent", fmt.Sprintf("%x.json", id)), nil
}

func (s *Server) loadCodexRuns() error {
 s.codexJournalMu.Lock()
 defer s.codexJournalMu.Unlock()
 path, err := s.codexJournalPath()
 if err != nil { return err }
 var runs []*codexRunState
 data, err := os.ReadFile(path)
 if err != nil && !errors.Is(err, os.ErrNotExist) { return err }
 if len(data) > 0 {
  if err := json.Unmarshal(data, &runs); err != nil { return fmt.Errorf("read agent run journal: %w", err) }
 }
 for _, run := range runs {
  if activeCodexRun(run) {
   run.Status = "interrupted"
   run.Error = "Kavla stopped before this run completed. Send a follow-up to continue from the saved canvas."
   run.Activity = ""
   run.Revision++
   for _, tool := range run.Tools { if tool.Status == "pending" || tool.Status == "running" { tool.Status = "cancelled" } }
  }
 }
 s.codexMu.Lock()
 s.codexHistory = runs
 s.codexRun = nil
 s.codexMu.Unlock()
 return nil
}

func (s *Server) currentCodexRuns() json.RawMessage {
 s.codexMu.Lock()
 defer s.codexMu.Unlock()
 data, _ := json.Marshal(s.codexHistory)
 return data
}

func (s *Server) publishCodexRuns(persist bool) {
 // Serialize publication with journal writes so an older snapshot cannot overwrite a newer one.
 s.codexJournalMu.Lock()
 defer s.codexJournalMu.Unlock()
 data := s.currentCodexRuns()
 if persist {
  path, err := s.codexJournalPath()
  if err == nil { err = os.MkdirAll(filepath.Dir(path), 0700) }
  if err == nil { err = atomicWriteFile(path, data, 0600) }
  if err != nil { s.logCLIOutput("Could not save agent run history: %v\n", err) }
 }
 s.broadcastCodexRuntimeEvent(cliRuntimeEvent{name: "runs", data: data})
}

func (s *Server) finishCodexRun(id, status, message string) {
 s.codexMu.Lock()
 run := s.codexRun
 if !activeCodexRun(run) || run.ID != id { s.codexMu.Unlock(); return }
 run.Status, run.Error, run.Activity = status, message, ""
 run.Revision++
 if run.cancel != nil { run.cancel() }
 for _, tool := range run.Tools {
  if tool.Status == "pending" || tool.Status == "running" { tool.Status = "cancelled" }
 }
 s.codexActiveThread, s.codexActiveTurn = "", ""
 s.codexMu.Unlock()
 s.publishCodexRuns(true)
}

func (s *Server) startCodexPrompt(request codexPromptRequest) error {
 if strings.TrimSpace(request.Prompt) == "" || request.RunID == "" || request.ClientID == "" { return fmt.Errorf("prompt, runId, and clientId are required") }
 if request.DocumentID != s.document.Manifest().DocumentID { return fmt.Errorf("the canvas document has changed") }
 s.codexMu.Lock()
 for _, run := range s.codexHistory { if run.ID == request.RunID { s.codexMu.Unlock(); return nil } }
 client := s.codexClient
 if client == nil || s.codexStatus.State != "ready" { message := s.codexStatus.Message; s.codexMu.Unlock(); return fmt.Errorf("%s", message) }
 if activeCodexRun(s.codexRun) { s.codexMu.Unlock(); return fmt.Errorf("the Agent is already working; stop the current run first") }
 model, layoutModel, err := resolveCodexModels(s.codexModels, request.MainModel, request.LayoutModel)
 if err != nil { s.codexMu.Unlock(); return err }
 ctx, cancel := context.WithTimeout(s.codexContext, 15*time.Minute)
 run := &codexRunState{ID: request.RunID, DocumentID: request.DocumentID, ClientID: request.ClientID, Model: model, Prompt: request.Prompt, Status: "planning", Activity: "Preparing analysis…", CreatedAt: time.Now().UnixMilli(), Revision: 1, Tools: []*codexToolState{}, ctx: ctx, cancel: cancel}
 s.codexRun = run
 s.codexHistory = append(s.codexHistory, run)
 if len(s.codexHistory) > 30 { s.codexHistory = s.codexHistory[len(s.codexHistory)-30:] }
 s.codexMu.Unlock()
 s.publishCodexRuns(true)
 s.workerMu.Lock()
 if s.closing { s.workerMu.Unlock(); s.finishCodexRun(run.ID, "cancelled", "Kavla is closing."); return fmt.Errorf("Kavla is closing") }
 s.workers.Add(1)
 s.workerMu.Unlock()
 go func() {
  defer s.workers.Done()
  defer func() { <-ctx.Done(); if ctx.Err() == context.DeadlineExceeded { s.cancelCodexRun(run.ID, "Agent run timed out.") } }()
  layoutPlan := ""
  if request.PlanLayout {
   layoutContext, cancelLayout := context.WithTimeout(ctx, codexOperationTimeout)
   layoutPlan, err = client.PlanLayout(layoutContext, layoutModel, request.Prompt, request.Context)
   cancelLayout()
   if err != nil && ctx.Err() == nil { s.logCLIOutput("Layout planner unavailable; using automatic placement: %v\n", err) }
  }
  if ctx.Err() != nil { return }
  operationContext, cancelOperation := context.WithTimeout(ctx, codexOperationTimeout)
  defer cancelOperation()
  threadID, resumed, err := client.StartOrResumeThread(operationContext, request.ThreadID, model)
  if err != nil { s.finishCodexRun(run.ID, "failed", err.Error()); return }
  history := ""
  if !resumed { history = request.FallbackHistory }
  prompt, err := codex.BuildPrompt(request.Prompt, request.Context, history, layoutPlan)
  if err != nil { s.finishCodexRun(run.ID, "failed", err.Error()); return }
  s.codexMu.Lock()
  if !activeCodexRun(run) || s.codexRun != run { s.codexMu.Unlock(); return }
  run.ThreadID, run.Status, run.Activity = threadID, "running", "Thinking…"
  run.Revision++
  s.codexActiveThread, s.codexActiveTurn = threadID, "starting"
  s.codexMu.Unlock()
  s.publishCodexRuns(true)
  turnID, err := client.StartTurn(operationContext, threadID, prompt)
  if err != nil { s.finishCodexRun(run.ID, "failed", err.Error()); return }
  s.codexMu.Lock()
  stillActive := s.codexRun == run && activeCodexRun(run)
  if stillActive { run.TurnID = turnID; run.Revision++; s.codexActiveTurn = turnID }
  s.codexMu.Unlock()
  if !stillActive {
   interruptContext, cancelInterrupt := context.WithTimeout(context.Background(), 5*time.Second)
   defer cancelInterrupt()
   _ = client.InterruptTurn(interruptContext, threadID, turnID)
   return
  }
  s.publishCodexRuns(true)
 }()
 return nil
}

func (s *Server) cancelCodexRun(id, reason string) {
 s.codexMu.Lock()
 run, client := s.codexRun, s.codexClient
 if !activeCodexRun(run) || (id != "" && run.ID != id) { s.codexMu.Unlock(); return }
 runID, threadID, turnID := run.ID, run.ThreadID, run.TurnID
 s.codexMu.Unlock()
 s.finishCodexRun(runID, "cancelled", reason)
 if client != nil && threadID != "" && turnID != "" {
  ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
  defer cancel()
  if err := client.InterruptTurn(ctx, threadID, turnID); err != nil { s.logCLIOutput("Could not interrupt agent: %v\n", err) }
 }
}

func (s *Server) handleCodexToolCall(requestID json.RawMessage, params json.RawMessage) {
 var request struct { Arguments map[string]interface{} `json:"arguments"`; CallID string `json:"callId"`; Namespace string `json:"namespace"`; ThreadID string `json:"threadId"`; Tool string `json:"tool"`; TurnID string `json:"turnId"` }
 err := json.Unmarshal(params, &request)
 s.codexMu.Lock()
 run, client := s.codexRun, s.codexClient
 reject := ""
 if err != nil || request.CallID == "" { reject = "Invalid canvas tool call." } else if !activeCodexRun(run) || run.ThreadID != request.ThreadID || (run.TurnID != "" && run.TurnID != request.TurnID) { reject = "This agent run is no longer active." } else if (request.Namespace != "" && request.Namespace != "kavla") || !isAllowedCodexCanvasTool(request.Tool) { reject = "Only Kavla canvas tools are available." }
 if reject == "" {
  for _, previous := range run.Tools {
   if previous.CallID == request.CallID {
    result, success, status := previous.Result, previous.Success, previous.Status
    s.codexMu.Unlock()
    if client != nil && status == "completed" { _ = client.RespondToTool(requestID, success, result) }
    return
   }
  }
  if len(run.Tools) >= 16 { reject = "The run has reached its tool budget. Finish with the best available evidence." }
 }
 if reject != "" { s.codexMu.Unlock(); if client != nil { _ = client.RespondToTool(requestID, false, map[string]string{"error": reject}) }; return }
 call := &codexToolState{CallID: request.CallID, Tool: request.Tool, Arguments: request.Arguments, Status: "pending", StartedAt: time.Now().UnixMilli(), RequestID: append(json.RawMessage(nil), requestID...)}
 run.Tools = append(run.Tools, call)
 run.Status, run.Activity = "waiting_for_tool", "Using " + strings.ReplaceAll(request.Tool, "_", " ") + "…"
 run.Revision++
 runID, ctx := run.ID, run.ctx
 s.codexMu.Unlock()
 s.publishCodexRuns(true)
 go func() {
  timer := time.NewTimer(8*time.Minute)
  defer timer.Stop()
  select {
  case <-ctx.Done(): return
  case <-timer.C:
   s.codexMu.Lock()
   pending := s.codexRun == run && activeCodexRun(run) && (call.Status == "pending" || call.Status == "running")
   s.codexMu.Unlock()
   if pending { s.cancelCodexRun(runID, "A canvas tool timed out. The existing canvas work has been kept.") }
  }
 }()
}

type codexClaimRequest struct { RunID string `json:"runId"`; ClientID string `json:"clientId"`; CallID string `json:"callId"` }

func (s *Server) handleCodexToolClaim(w http.ResponseWriter, r *http.Request) {
 r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
 var request codexClaimRequest
 if json.NewDecoder(r.Body).Decode(&request) != nil { writeAPIError(w, 400, fmt.Errorf("invalid claim")); return }
 s.codexMu.Lock()
 run := s.codexRun
 claimed := false
 if activeCodexRun(run) && run.ID == request.RunID && run.ClientID == request.ClientID {
  for _, call := range run.Tools { if call.CallID == request.CallID && call.Status == "pending" { call.Status = "running"; run.Revision++; claimed = true; break } }
 }
 s.codexMu.Unlock()
 if claimed { s.publishCodexRuns(true) }
 w.Header().Set("Content-Type", "application/json")
 _ = json.NewEncoder(w).Encode(map[string]bool{"claimed": claimed})
}

func (s *Server) acceptCodexToolResult(request codexToolResultRequest) error {
 s.codexMu.Lock()
 run, client := s.codexRun, s.codexClient
 if !activeCodexRun(run) || run.ID != request.RunID || run.ClientID != request.ClientID || client == nil { s.codexMu.Unlock(); return fmt.Errorf("this agent run is no longer active") }
 var call *codexToolState
 for _, candidate := range run.Tools { if candidate.CallID == request.CallID { call = candidate; break } }
 if call == nil { s.codexMu.Unlock(); return fmt.Errorf("unknown tool call") }
 if call.Status == "completed" { s.codexMu.Unlock(); return nil }
 if call.Status != "running" { s.codexMu.Unlock(); return fmt.Errorf("tool call must be claimed before returning a result") }
 value := request.Result
 if !request.Success && value == nil { value = map[string]interface{}{"error": request.Error} }
 call.Result, call.Success, call.Error, call.Status = value, request.Success, request.Error, "completed"
 run.Status, run.Activity = "running", "Thinking…"
 run.Revision++
 requestID := call.RequestID
 s.codexMu.Unlock()
 s.publishCodexRuns(true)
 if err := client.RespondToTool(requestID, request.Success, value); err != nil { s.finishCodexRun(run.ID, "failed", err.Error()); return err }
 return nil
}

func (s *Server) handleCodexGenerate(w http.ResponseWriter, r *http.Request) {
 r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
 var request struct { RunID string `json:"runId"`; ClientID string `json:"clientId"`; Mode string `json:"mode"`; Prompt string `json:"prompt"`; Context interface{} `json:"context"` }
 if json.NewDecoder(r.Body).Decode(&request) != nil { writeAPIError(w, 400, fmt.Errorf("invalid generation request")); return }
 if request.Mode != "sql" && request.Mode != "lens" { writeAPIError(w, 400, fmt.Errorf("unknown generation mode")); return }
 s.codexMu.Lock()
 run, client := s.codexRun, s.codexClient
 if !activeCodexRun(run) || run.ID != request.RunID || run.ClientID != request.ClientID || client == nil { s.codexMu.Unlock(); writeAPIError(w, 409, fmt.Errorf("this agent run is no longer active")); return }
 parent, model := run.ctx, run.Model
 run.Activity = "Generating " + request.Mode + "…"; run.Revision++
 s.codexMu.Unlock()
 s.publishCodexRuns(true)
 ctx, cancel := context.WithTimeout(parent, 120*time.Second)
 stop := context.AfterFunc(r.Context(), cancel)
 defer stop(); defer cancel()
 result, err := client.Generate(ctx, request.Mode, model, request.Prompt, request.Context)
 if err != nil { writeAPIError(w, 500, err); return }
 w.Header().Set("Content-Type", "application/json")
 _ = json.NewEncoder(w).Encode(result)
}
