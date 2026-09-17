package localapp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aleda145/kavla/cli/internal/agent"
)

type generationTestRuntime struct {
	agent.Runtime
	generate func(context.Context, string) (map[string]interface{}, error)
}

func (c *generationTestRuntime) Generate(ctx context.Context, mode, model, prompt string, canvas interface{}) (map[string]interface{}, error) {
	return c.generate(ctx, mode)
}

func (c *generationTestRuntime) Close() error { return nil }

func TestGenerationDeadlines(t *testing.T) {
	for _, test := range []struct {
		name, mode string
		runBudget, expected time.Duration
	}{
		{"heavy Lens", "lens", 15*time.Minute, 10*time.Minute},
		{"SQL", "sql", 15*time.Minute, 5*time.Minute},
		{"remaining run budget", "lens", time.Minute, time.Minute},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := newAPIAgentTestServer(t)
			parent, cancel := context.WithTimeout(context.Background(), test.runBudget)
			defer cancel()
			run := &agentRunState{ID: "run", ClientID: "owner", Status: "waiting_for_tool", ctx: parent, cancel: cancel}
			s.agentRun, s.agentHistory = run, []*agentRunState{run}
			s.agentClient = &generationTestRuntime{generate: func(ctx context.Context, mode string) (map[string]interface{}, error) {
				deadline, ok := ctx.Deadline()
				remaining := time.Until(deadline)
				if !ok || remaining > test.expected || remaining < test.expected-time.Second { t.Errorf("unexpected generation budget: %s", remaining) }
				return map[string]interface{}{"code": "Lens", "sql": "SELECT 1"}, nil
			}}
			w := httptest.NewRecorder()
			s.handleAgentGenerate(w, httptest.NewRequest(http.MethodPost, "/api/agent/generate", strings.NewReader(`{"runId":"run","clientId":"owner","mode":"`+test.mode+`","prompt":"Generate"}`)))
			if w.Code != http.StatusOK { t.Fatal(w.Body.String()) }
		})
	}
}

func TestGenerationReportsWhichDeadlineExpired(t *testing.T) {
	for _, runExpired := range []bool{false, true} {
		s := newAPIAgentTestServer(t)
		deadline := time.Now().Add(15*time.Minute)
		if runExpired { deadline = time.Now().Add(-time.Second) }
		parent, cancel := context.WithDeadline(context.Background(), deadline)
		defer cancel()
		run := &agentRunState{ID: "run", ClientID: "owner", Status: "waiting_for_tool", ctx: parent, cancel: cancel}
		s.agentRun, s.agentHistory = run, []*agentRunState{run}
		s.agentClient = &generationTestRuntime{generate: func(context.Context, string) (map[string]interface{}, error) { return nil, context.DeadlineExceeded }}
		w := httptest.NewRecorder()
		s.handleAgentGenerate(w, httptest.NewRequest(http.MethodPost, "/api/agent/generate", strings.NewReader(`{"runId":"run","clientId":"owner","mode":"lens","prompt":"Generate"}`)))
		expected := "Lens generation exceeded its 10-minute limit"
		if runExpired { expected = "Agent run exceeded its 15-minute limit" }
		if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), expected) { t.Fatalf("unexpected timeout error: %d %s", w.Code, w.Body.String()) }
	}
}

func TestGenerationStopsWhenBrowserRequestIsCancelled(t *testing.T) {
	s := newAPIAgentTestServer(t)
	parent, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	run := &agentRunState{ID: "run", ClientID: "owner", Status: "waiting_for_tool", ctx: parent, cancel: cancel}
	s.agentRun, s.agentHistory = run, []*agentRunState{run}
	s.agentClient = &generationTestRuntime{generate: func(ctx context.Context, mode string) (map[string]interface{}, error) {
		select {
		case <-ctx.Done(): return nil, ctx.Err()
		case <-time.After(time.Second): t.Error("generation ignored request cancellation"); return nil, context.DeadlineExceeded
		}
	}}
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()
	w := httptest.NewRecorder()
	s.handleAgentGenerate(w, httptest.NewRequest(http.MethodPost, "/api/agent/generate", strings.NewReader(`{"runId":"run","clientId":"owner","mode":"lens","prompt":"Generate"}`)).WithContext(requestCtx))
	if !strings.Contains(w.Body.String(), "context canceled") { t.Fatal(w.Body.String()) }
}
