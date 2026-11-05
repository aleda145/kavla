package localapp

import (
	"errors"
	"net/http"
	"time"
)

// A result stream owns the compute gate until its reader is released. Bound
// each browser write so a suspended client cannot hold up every later query.
// Clear the deadline between writes: executing SQL may legitimately take longer.
type resultWriter struct {
	w http.ResponseWriter
}

func (w resultWriter) Write(data []byte) (int, error) {
	controller := http.NewResponseController(w.w)
	if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		// In-memory HTTP recorders have no socket or deadlines.
		if errors.Is(err, http.ErrNotSupported) {
			return w.w.Write(data)
		}
		return 0, err
	}
	n, err := w.w.Write(data)
	clearErr := controller.SetWriteDeadline(time.Time{})
	if err != nil {
		return n, err
	}
	return n, clearErr
}
