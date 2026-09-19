package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const editorTransferTimeout = 60 * time.Second

type editorTransfer struct {
	id         string
	ownerToken string
	result     chan error
	saved      bool
}

// The owner retains write access while its browser drains uploads and stages
// its latest canvas. Only a successful, acknowledged save permits a transfer.
func (s *Server) transferEditor(ctx context.Context, client string) (string, string, error) {
	if client == "" {
		return "", "", fmt.Errorf("an editor client ID is required")
	}
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	s.editorMu.Lock()
	s.ownerMu.RLock()
	ownerToken, ownerContext, events := s.ownerToken, s.ownerContext, s.ownerEvents
	s.ownerMu.RUnlock()
	if ownerToken == "" {
		token, generation, _, err := s.acquireEditor(ctx, client, "")
		s.editorMu.Unlock()
		return token, generation, err
	}
	if ownerContext.Err() != nil {
		s.editorMu.Unlock()
		return "", "", fmt.Errorf("the other session is disconnected; reconnect it and save before trying again")
	}
	pending := &editorTransfer{id: uuid.NewString(), ownerToken: ownerToken, result: make(chan error, 1)}
	s.transferMu.Lock()
	if s.transfer != nil {
		s.transferMu.Unlock()
		s.editorMu.Unlock()
		return "", "", fmt.Errorf("another session is already waiting for this canvas to be saved")
	}
	s.transfer = pending
	s.transferMu.Unlock()
	select {
	case events <- cliRuntimeEvent{name: "save-request", data: map[string]string{"requestId": pending.id}}:
	default:
		s.transferMu.Lock()
		s.transfer = nil
		s.transferMu.Unlock()
		s.editorMu.Unlock()
		return "", "", fmt.Errorf("the other session could not be reached; try again")
	}
	s.editorMu.Unlock()

	completed := false
	defer func() {
		s.transferMu.Lock()
		if s.transfer == pending {
			s.transfer = nil
		}
		s.transferMu.Unlock()
		if !completed {
			select {
			case events <- cliRuntimeEvent{name: "transfer-cancelled", data: map[string]string{"requestId": pending.id}}:
			default:
			}
		}
	}()
	timer := time.NewTimer(editorTransferTimeout)
	defer timer.Stop()
	select {
	case err := <-pending.result:
		if err != nil {
			return "", "", fmt.Errorf("the other session could not save: %w", err)
		}
	case <-ownerContext.Done():
		return "", "", fmt.Errorf("the other session disconnected before confirming its save; reconnect it and try again")
	case <-ctx.Done():
		return "", "", ctx.Err()
	case <-timer.C:
		return "", "", fmt.Errorf("the other session did not finish saving within 60 seconds; open that tab and try again")
	}

	s.editorMu.Lock()
	defer s.editorMu.Unlock()
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	s.ownerMu.RLock()
	current, cancel := s.ownerToken == ownerToken, s.ownerCancel
	s.ownerMu.RUnlock()
	if !current {
		return "", "", fmt.Errorf("the canvas editor changed; try opening it again")
	}
	cancel()
	s.ownerMu.Lock()
	defer s.ownerMu.Unlock()
	close(s.ownerRevoked)
	token, generation := s.grantEditor(ctx, client)
	completed = true
	return token, generation, nil
}

// documentRequests holds the document gate, and the registry validates the
// owner's token. The save and its acknowledgement are one server operation.
func (s *Server) handleEditorTransferResult(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	var request struct {
		RequestID string `json:"requestId"`
		Error     string `json:"error,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, fmt.Errorf("invalid editor transfer response"))
		return
	}
	s.transferMu.Lock()
	pending := s.transfer
	valid := pending != nil && pending.id == request.RequestID && pending.ownerToken == r.Header.Get("X-Kavla-Editor")
	s.transferMu.Unlock()
	if !valid {
		writeAPIError(w, http.StatusConflict, fmt.Errorf("this save request is no longer pending"))
		return
	}
	var saveErr error
	if request.Error != "" {
		saveErr = fmt.Errorf("%s", request.Error)
	} else {
		saveErr = s.document.Save()
	}
	s.transferMu.Lock()
	if s.transfer != pending {
		s.transferMu.Unlock()
		writeAPIError(w, http.StatusConflict, fmt.Errorf("the transfer was cancelled; this session still owns the canvas"))
		return
	}
	pending.saved = saveErr == nil
	select {
	case pending.result <- saveErr:
	default:
	}
	s.transferMu.Unlock()
	if saveErr != nil {
		writeAPIError(w, http.StatusInternalServerError, saveErr)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
