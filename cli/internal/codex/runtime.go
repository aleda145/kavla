package codex

import (
	"context"
	"encoding/json"
)

// Runtime keeps the canvas tool broker and run journal independent of the model transport.
type Runtime interface {
	ListModels(context.Context) ([]Model, error)
	StartOrResumeThread(context.Context, string, string) (string, bool, error)
	StartTurn(context.Context, string, string) (string, error)
	PlanLayout(context.Context, string, string, interface{}) (string, error)
	Generate(context.Context, string, string, string, interface{}) (map[string]interface{}, error)
	InterruptTurn(context.Context, string, string) error
	RespondToTool(json.RawMessage, bool, interface{}) error
	Close() error
}
