package localapp

import (
	"context"
	"errors"
	"time"
)

const idleComputeGracePeriod = 15 * time.Second

// Both helpers require editorMu. Only the owning editor's disconnect schedules
// suspension; blocked tabs and superseded connections cannot stop its worker.
func (s *Server) cancelIdleComputeLocked() {
	if s.idleComputeTimer != nil {
		s.idleComputeTimer.Stop()
		s.idleComputeTimer = nil
	}
}

func (s *Server) scheduleIdleComputeLocked() {
	s.cancelIdleComputeLocked()
	s.workerMu.Lock()
	closing := s.closing
	s.workerMu.Unlock()
	if closing {
		return
	}
	var timer *time.Timer
	timer = time.AfterFunc(idleComputeGracePeriod, func() {
		// Serialize the ownership check and suspension with reconnect/transfer.
		s.editorMu.Lock()
		defer s.editorMu.Unlock()
		if s.idleComputeTimer != timer {
			return
		}
		s.idleComputeTimer = nil
		s.ownerMu.RLock()
		owned := s.ownerToken != ""
		s.ownerMu.RUnlock()
		if owned {
			return
		}
		s.workerMu.Lock()
		if s.closing {
			s.workerMu.Unlock()
			return
		}
		// Register before shutdown starts waiting; never hold workerMu while
		// waiting for native work or the compute gate.
		s.workers.Add(1)
		s.workerMu.Unlock()
		defer s.workers.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.queriesMu.RLock()
		err := s.queries.SuspendCompute(ctx)
		s.queriesMu.RUnlock()
		if err != nil && !errors.Is(err, context.Canceled) {
			s.logCLIOutput("Could not stop inactive canvas compute: %v\n", err)
			// A request still releasing its reader must not permanently prevent
			// cleanup. Reconnect cancels this retry just like the initial timer.
			s.scheduleIdleComputeLocked()
		}
	})
	s.idleComputeTimer = timer
}
