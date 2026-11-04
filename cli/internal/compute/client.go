package compute

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/spilldir"
	"github.com/apache/arrow/go/v14/arrow/array"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

const stoppedMessage = "DuckDB service stopped or lost its connection. Your canvas is still open. Run the operation again to restart compute"

type process struct {
	cmd     *exec.Cmd
	control io.WriteCloser
	address string
	token   string
	done    chan struct{}
}

// Client serializes operations for one document. A streaming Arrow result owns
// the gate until Release, so results cross the process boundary batch by batch.
type Client struct {
	ctx             context.Context
	cancel          context.CancelFunc
	config          configuration
	logf            func(string, ...interface{})
	transport       *http.Transport
	http            *http.Client
	gate            chan struct{}
	mu              sync.Mutex
	sourcesNotifyMu sync.Mutex
	worker          *process
	statuses        []engine.SourceStatus
	sourcesChanged  func()
	closed          bool
	uploadsEnabled  bool
	workerError     string
	journal         []request // Successful source/view mutations, replayed after a crash.
	restoredViews   map[string]bool
}

func New(ctx context.Context, sources map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{}), directories []string) (*Client, error) {
	c := NewLazy(ctx, sources, logf, directories)
	if _, err := c.call(ctx, request{Op: "initialize"}); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// NewLazy keeps canvas opening independent of native compute and source I/O.
// The first compute request starts the supervised worker through the same gate.
func NewLazy(ctx context.Context, sources map[string]kavlaconfig.SourceConfig, logf func(string, ...interface{}), directories []string) *Client {
	if logf == nil {
		logf = log.Printf
	}
	ctx, cancel := context.WithCancel(ctx)
	transport := &http.Transport{MaxIdleConnsPerHost: 1, IdleConnTimeout: time.Minute}
	c := &Client{
		ctx: ctx, cancel: cancel, logf: logf, transport: transport,
		http: &http.Client{Transport: transport}, gate: make(chan struct{}, 1),
		config: configuration{Sources: sources, Directories: slices.Clone(directories)},
	}
	for name, source := range sources {
		c.statuses = append(c.statuses, engine.SourceStatus{Name: name, Type: source.Type})
	}
	return c
}

func (c *Client) startWorker(ctx context.Context) (*process, ready, error) {
	userConfig, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return nil, ready{}, fmt.Errorf("load compute memory settings: %w", err)
	}
	settings, err := userConfig.Memory.Resolve()
	if err != nil {
		return nil, ready{}, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, ready{}, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, ready{}, err
	}
	config := c.config
	config.Memory = settings
	config.Token = hex.EncodeToString(secret)
	cmd := exec.Command(executable, workerArgument)
	control, err := cmd.StdinPipe()
	if err != nil {
		return nil, ready{}, err
	}
	// Own the read ends ourselves. Cmd.Wait must not close them before the
	// startup decoder has read a worker's final error message.
	stdout, stdoutChild, err := os.Pipe()
	if err != nil {
		_ = control.Close()
		return nil, ready{}, err
	}
	stderr, stderrChild, err := os.Pipe()
	if err != nil {
		_ = control.Close()
		_ = stdout.Close()
		_ = stdoutChild.Close()
		return nil, ready{}, err
	}
	cmd.Stdout = stdoutChild
	cmd.Stderr = stderrChild
	if err := cmd.Start(); err != nil {
		_ = control.Close()
		_ = stdout.Close()
		_ = stdoutChild.Close()
		_ = stderr.Close()
		_ = stderrChild.Close()
		return nil, ready{}, fmt.Errorf("start DuckDB service: %w", err)
	}
	_ = stdoutChild.Close()
	_ = stderrChild.Close()
	p := &process{cmd: cmd, control: control, token: config.Token, done: make(chan struct{})}
	go func() {
		defer stderr.Close()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			if data, ok := strings.CutPrefix(scanner.Text(), sourceStatusPrefix); ok {
				var status engine.SourceStatus
				if err := json.Unmarshal([]byte(data), &status); err == nil {
					c.updateWorkerSourceStatuses(p, []engine.SourceStatus{status})
					continue
				}
			}
			c.logf("[DuckDB %d] %s\n", cmd.Process.Pid, scanner.Text())
		}
		// Keep draining even if a native extension emits an unusually long line.
		_, _ = io.Copy(io.Discard, stderr)
	}()
	go func() {
		_ = cmd.Wait()
		if err := spilldir.Cleanup(); err != nil {
			c.logf("Clean up DuckDB spill files after worker exit: %v\n", err)
		}
		close(p.done)
		c.mu.Lock()
		isCurrent := c.worker == p
		c.mu.Unlock()
		if isCurrent {
			c.notifySourcesChanged()
		}
	}()
	startup := make(chan ready, 1)
	go func() {
		defer stdout.Close()
		if err := json.NewEncoder(control).Encode(config); err != nil {
			startup <- ready{Error: fmt.Sprintf("send compute configuration: %v", err)}
			return
		}
		var result ready
		if err := json.NewDecoder(io.LimitReader(stdout, 4<<20)).Decode(&result); err != nil {
			result.Error = fmt.Sprintf("read compute startup: %v", err)
		}
		startup <- result
		// Native extensions may write to stdout after the handshake. Drain it
		// so logging cannot block their query threads on a full pipe.
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case result := <-startup:
		if result.Error != "" {
			p.kill()
			return nil, ready{}, fmt.Errorf("start DuckDB service: %s", result.Error)
		}
		p.address = "http://" + result.Address + "/execute"
		return p, result, nil
	case <-ctx.Done():
		p.kill()
		return nil, ready{}, ctx.Err()
	}
}

func (p *process) kill() {
	_ = p.control.Close()
	_ = p.cmd.Process.Kill()
	<-p.done
}

func (c *Client) ensureWorker(ctx context.Context) (_ *process, startupErr error) {
	c.mu.Lock()
	p := c.worker
	closed := c.closed
	c.mu.Unlock()
	if closed || c.ctx.Err() != nil {
		return nil, context.Canceled
	}
	if p != nil {
		select {
		case <-p.done:
			_ = p.control.Close()
		default:
			return p, nil
		}
		c.logf("DuckDB service exited. Restoring compute; the canvas is still open.\n")
	}
	c.mu.Lock()
	c.worker = nil
	c.workerError = ""
	c.markSourcesDisconnectedLocked()
	c.mu.Unlock()
	c.notifySourcesChanged()
	defer func() {
		if startupErr != nil {
			c.mu.Lock()
			c.workerError = startupErr.Error()
			c.mu.Unlock()
		}
		c.notifySourcesChanged()
	}()
	startupCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	next, info, err := c.startWorker(startupCtx)
	cancel()
	if err != nil {
		return nil, err
	}
	for _, req := range c.journal {
		if req.Op == "create-view" {
			// Restore views on demand. A view referencing a subsequently deleted
			// table must not prevent recovery of the rest of the document.
			continue
		}
		// Re-importing large files may legitimately take longer than worker
		// startup. Keep it cancellable by the request/session, without imposing
		// the handshake timeout on the document's data.
		if req.Op == "import" {
			req.Op = "register-upload"
		}
		if _, err := c.sendJSON(ctx, next, req); err != nil {
			next.kill()
			return nil, fmt.Errorf("restore DuckDB service: %w", err)
		}
	}
	c.mu.Lock()
	if c.closed || c.ctx.Err() != nil {
		c.mu.Unlock()
		next.kill()
		return nil, context.Canceled
	}
	c.worker = next
	c.restoredViews = make(map[string]bool)
	c.statuses = info.Statuses
	c.workerError = ""
	c.mu.Unlock()
	if info.Limit == 0 {
		c.logf("DuckDB service %d started; hard memory enforcement is currently Linux-only.\n", next.cmd.Process.Pid)
	} else {
		c.logf("DuckDB service %d started; compute processes share a %.2f GiB memory cap; DuckDB budget %.2f GiB; configured swap limit %d MiB.\n", next.cmd.Process.Pid, float64(info.Limit)/(1<<30), float64(info.DuckDBLimit)/(1<<30), info.SwapLimitMiB)
	}
	return next, nil
}

func (c *Client) operation(ctx context.Context) (context.Context, func(), error) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(c.ctx, cancel)
	select {
	case c.gate <- struct{}{}:
		return ctx, func() { stop(); cancel(); <-c.gate }, nil
	case <-ctx.Done():
		stop()
		cancel()
		return nil, nil, ctx.Err()
	}
}

func (c *Client) invalidate(p *process) {
	c.mu.Lock()
	if c.worker == p {
		c.worker = nil
		c.workerError = stoppedMessage
	}
	c.mu.Unlock()
	// Cancellation also discards the worker: an interrupted mutation must not
	// keep running after its caller rolls back an upload or deletes a file.
	p.kill()
	c.notifySourcesChanged()
}

func (c *Client) send(ctx context.Context, p *process, req request) (*http.Response, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.address, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+p.token)
	httpReq.Header.Set("Content-Type", "application/json")
	result, err := c.http.Do(httpReq)
	if err != nil {
		c.invalidate(p)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%s: %w", stoppedMessage, err)
	}
	if data := result.Header.Get(sourceStatusesHeader); data != "" {
		var statuses []engine.SourceStatus
		if err := json.Unmarshal([]byte(data), &statuses); err != nil {
			_ = result.Body.Close()
			c.invalidate(p)
			return nil, fmt.Errorf("read compute source statuses: %w", err)
		}
		c.updateWorkerSourceStatuses(p, statuses)
	}
	return result, nil
}

func (c *Client) updateWorkerSourceStatuses(p *process, statuses []engine.SourceStatus) {
	c.mu.Lock()
	changed := false
	if c.worker == p && !c.closed {
		for _, status := range statuses {
			for i := range c.statuses {
				// Pipe progress and HTTP snapshots can arrive in either order.
				if c.statuses[i].Name == status.Name && status.Revision >= c.statuses[i].Revision && c.statuses[i] != status {
					c.statuses[i] = status
					changed = true
					break
				}
			}
		}
	}
	c.mu.Unlock()
	if changed {
		c.notifySourcesChanged()
	}
}

func (c *Client) sendJSON(ctx context.Context, p *process, req request) (response, error) {
	res, err := c.send(ctx, p, req)
	if err != nil {
		return response{}, err
	}
	defer res.Body.Close()
	var result response
	if err := json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(&result); err != nil {
		c.invalidate(p)
		return result, fmt.Errorf("%s: %w", stoppedMessage, err)
	}
	if result.Error != "" {
		return result, fmt.Errorf("%s", result.Error)
	}
	if res.StatusCode != http.StatusOK {
		return result, fmt.Errorf("compute service returned HTTP %d", res.StatusCode)
	}
	return result, nil
}

func (c *Client) call(ctx context.Context, req request) (response, error) {
	ctx, done, err := c.operation(ctx)
	if err != nil {
		return response{}, err
	}
	defer done()
	p, err := c.ensureWorker(ctx)
	if err != nil {
		return response{}, err
	}
	if err := c.restoreView(ctx, p, req); err != nil {
		return response{}, err
	}
	result, err := c.sendJSON(ctx, p, req)
	if err == nil {
		c.remember(req)
	}
	return result, err
}

func (c *Client) remember(req request) {
	op, id := req.Op, req.ID
	switch op {
	case "import", "create-view":
		if op == "create-view" {
			c.restoredViews[id] = true
		}
	case "mount":
		id = req.Source
	case "drop-upload":
		op = "import"
	case "drop-view":
		op = "create-view"
		delete(c.restoredViews, id)
	default:
		return
	}
	for i, previous := range c.journal {
		previousID := previous.ID
		if previous.Op == "mount" {
			previousID = previous.Source
		}
		if previous.Op == op && previousID == id {
			if req.Op == op {
				c.journal[i] = req
				return
			}
			c.journal = slices.Delete(c.journal, i, i+1)
			break
		}
	}
	if req.Op == op {
		c.journal = append(c.journal, req)
	}
}

func (c *Client) restoreView(ctx context.Context, p *process, req request) error {
	switch req.Op {
	case "count", "schema", "page", "export-result":
	default:
		return nil
	}
	if c.restoredViews[req.ID] {
		return nil
	}
	for _, previous := range c.journal {
		if previous.Op == "create-view" && previous.ID == req.ID {
			if _, err := c.sendJSON(ctx, p, previous); err != nil {
				return fmt.Errorf("restore query result: %w", err)
			}
			c.restoredViews[req.ID] = true
			break
		}
	}
	return nil
}

func (c *Client) query(ctx context.Context, req request) (array.RecordReader, error) {
	ctx, done, err := c.operation(ctx)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			done()
		}
	}()
	p, err := c.ensureWorker(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.restoreView(ctx, p, req); err != nil {
		return nil, err
	}
	res, err := c.send(ctx, p, req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		var result response
		if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&result); err != nil {
			c.invalidate(p)
			return nil, fmt.Errorf("%s: %w", stoppedMessage, err)
		}
		return nil, fmt.Errorf("%s", result.Error)
	}
	reader, err := ipc.NewReader(res.Body)
	if err != nil {
		_ = res.Body.Close()
		c.invalidate(p)
		return nil, fmt.Errorf("%s: %w", stoppedMessage, err)
	}
	result := &streamReader{Reader: reader, response: res, done: done, failed: func() { c.invalidate(p) }}
	result.refs.Store(1)
	success = true
	return result, nil
}

type streamReader struct {
	*ipc.Reader
	response *http.Response
	done     func()
	failed   func()
	refs     atomic.Int64
	err      error
	finished bool
}

func (r *streamReader) Retain() { r.refs.Add(1) }
func (r *streamReader) Release() {
	if r.refs.Add(-1) == 0 {
		r.Reader.Release()
		_ = r.response.Body.Close()
		if !r.finished {
			r.failed()
		}
		r.done()
	}
}
func (r *streamReader) Next() bool {
	if r.finished {
		return false
	}
	if r.Reader.Next() {
		return true
	}
	r.finished = true
	_, transportErr := io.Copy(io.Discard, r.response.Body)
	if r.Reader.Err() != nil || transportErr != nil || r.response.Trailer.Get(completeTrailer) != "1" {
		r.err = fmt.Errorf("%s; the result was interrupted", stoppedMessage)
		r.failed()
	}
	return false
}
func (r *streamReader) Err() error { return r.err }

// Suspend releases the native process while retaining the replay journal and
// session context. The next operation restores compute through ensureWorker.
func (c *Client) Suspend(ctx context.Context) error {
	ctx, done, err := c.operation(ctx)
	if err != nil {
		return err
	}
	defer done()
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	p := c.worker
	c.worker = nil
	c.workerError = ""
	c.markSourcesDisconnectedLocked()
	c.mu.Unlock()
	c.notifySourcesChanged()
	c.restoredViews = nil
	c.transport.CloseIdleConnections()
	if p == nil {
		return nil
	}
	_ = p.control.Close()
	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	select {
	case <-p.done:
	case <-ctx.Done():
		p.kill()
	case <-timer.C:
		p.kill()
	}
	c.logf("DuckDB service %d stopped for an inactive canvas; compute will restart on demand.\n", p.cmd.Process.Pid)
	return nil
}

func (c *Client) Close() error {
	c.cancel()
	c.mu.Lock()
	c.closed = true
	p := c.worker
	c.worker = nil
	c.mu.Unlock()
	c.transport.CloseIdleConnections()
	if p != nil {
		_ = p.control.Close()
		select {
		case <-p.done:
		case <-time.After(4 * time.Second):
			p.kill()
		}
	}
	return nil
}

func (c *Client) EnableUploadedFiles() {
	c.mu.Lock()
	c.uploadsEnabled = true
	c.mu.Unlock()
}

// The handler must not acquire the caller's session/operation locks. It runs
// outside mu so it can read SourceStatuses without blocking worker startup.
func (c *Client) SetSourcesChangedHandler(handler func()) {
	c.mu.Lock()
	c.sourcesChanged = handler
	c.mu.Unlock()
}

func (c *Client) notifySourcesChanged() {
	// Worker exit and operation callbacks can race. Keep snapshots and delivery
	// ordered so an older snapshot cannot overwrite a newer one in the browser.
	c.sourcesNotifyMu.Lock()
	defer c.sourcesNotifyMu.Unlock()
	c.mu.Lock()
	handler := c.sourcesChanged
	closed := c.closed
	c.mu.Unlock()
	if handler != nil && !closed {
		handler()
	}
}

func (c *Client) markSourcesDisconnectedLocked() {
	for i := range c.statuses {
		c.statuses[i].Available = false
		c.statuses[i].Loading = false
		c.statuses[i].Revision = 0
		c.statuses[i].Error = ""
	}
}

func (c *Client) SourceStatuses() []engine.SourceStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	statuses := slices.Clone(c.statuses)
	if c.uploadsEnabled {
		statuses = append(statuses, engine.SourceStatus{Name: engine.UploadedFilesSource, Type: "duckdb", Available: true})
	}
	message := c.workerError
	if c.worker != nil {
		select {
		case <-c.worker.done:
			message = stoppedMessage
		default:
		}
	}
	if message != "" {
		for i := range statuses {
			statuses[i].Available = false
			statuses[i].Loading = false
			statuses[i].Error = message
		}
	}
	slices.SortFunc(statuses, func(a, b engine.SourceStatus) int {
		if a.Name < b.Name {
			return -1
		}
		if a.Name > b.Name {
			return 1
		}
		return 0
	})
	return statuses
}
