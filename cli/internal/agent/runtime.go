package agent

import (
	"context"
	"encoding/json"
)

type Status struct {
	State   string `json:"state"`
	Message string `json:"message"`
}

type Model struct {
	ID                     string                     `json:"id"`
	Model                  string                     `json:"model"`
	DisplayName            string                     `json:"displayName"`
	Hidden                 bool                       `json:"hidden"`
	DefaultReasoningEffort string                     `json:"defaultReasoningEffort,omitempty"`
	SupportedEfforts       []SupportedReasoningEffort `json:"supportedReasoningEfforts,omitempty"`
	IsDefault              bool                       `json:"isDefault"`
}

type SupportedReasoningEffort struct {
	ReasoningEffort string `json:"reasoningEffort"`
	Description     string `json:"description"`
}

type EventHandler func(method string, params json.RawMessage)
type ToolHandler func(requestID json.RawMessage, params json.RawMessage)
type ExitHandler func(error)

// Runtime keeps the canvas tool broker and run journal independent of the model transport.
type Runtime interface {
	ListModels(context.Context) ([]Model, error)
	StartOrResumeThread(context.Context, string, string) (string, bool, error)
	StartTurn(context.Context, string, string) (string, error)
	GenerateLens(context.Context, string, string, interface{}) (map[string]interface{}, error)
	InterruptTurn(context.Context, string, string) error
	RespondToTool(json.RawMessage, bool, interface{}) error
	Close() error
}
