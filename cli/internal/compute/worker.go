package compute

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/aleda145/kavla/cli/internal/engine"
	"github.com/aleda145/kavla/cli/internal/memoryguard"
	"github.com/apache/arrow/go/v14/arrow/array"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

// Re-exec the shipped executable (including Go test executables) without a
// second binary or a public CLI command. Configuration travels over a private
// pipe, never argv or the environment. Normal invocations never enter here.
func init() {
	if len(os.Args) != 2 || os.Args[1] != workerArgument {
		return
	}
	if err := runWorker(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(ready{Error: err.Error()})
		os.Exit(1)
	}
	os.Exit(0)
}

func runWorker() error {
	var config configuration
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&config); err != nil {
		return fmt.Errorf("read compute configuration: %w", err)
	}
	if len(config.Token) < 32 {
		return fmt.Errorf("compute authentication token is missing")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		// EOF means the parent exited or explicitly closed this worker. Give
		// DuckDB a chance to close normally, then exit even if native code hangs.
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
		time.Sleep(3 * time.Second)
		os.Exit(0)
	}()
	limit, err := memoryguard.Enable(config.Memory)
	if err != nil {
		return err
	}
	eng, err := engine.NewLazyWithAllowedDirectories(config.Sources, log.Printf, config.Directories)
	if err != nil {
		return err
	}
	defer func() {
		if err := eng.Close(); err != nil {
			log.Printf("Close DuckDB and clean up spill files: %v", err)
		}
	}()
	eng.SetSourceStatusHandler(func(status engine.SourceStatus) {
		// stderr already has a continuously drained parent pipe. Structured
		// status lines report readiness before a long-running query completes.
		data, _ := json.Marshal(status)
		fmt.Fprintln(os.Stderr, sourceStatusPrefix+string(data))
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != "/execute" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+config.Token)) != 1 {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			serveOperation(eng, w, r)
		}),
	}
	defer server.Close()
	if err := json.NewEncoder(os.Stdout).Encode(ready{Address: listener.Addr().String(), Statuses: eng.SourceStatuses(), Limit: limit, DuckDBLimit: memoryguard.DuckDBLimit(), SwapLimitMiB: config.Memory.SwapLimitMiB}); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		_ = server.Close()
		return nil
	case err := <-done:
		return err
	}
}

func serveOperation(eng *engine.Engine, w http.ResponseWriter, r *http.Request) {
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeResponse(w, response{}, err)
		return
	}
	ctx := r.Context()
	var result response
	var reader array.RecordReader
	var err error
	switch req.Op {
	case "initialize":
		eng.InitializeSources(ctx)
	case "query":
		reader, err = eng.Query(ctx, req.SQL)
	case "page":
		reader, err = eng.QueryResultPage(ctx, req.ID, req.Offset, req.Limit)
	case "widget":
		reader, err = eng.QueryWidget(ctx, req.SQL, req.ID, req.Columns, req.Rows)
	case "estimate":
		result.Estimate, err = eng.EstimateQuery(ctx, req.ExecutionEngine, req.Source, req.SQL)
	case "preview":
		result.SQL, err = eng.PreparePreviewSQLContext(ctx, req.ExecutionEngine, req.Source, req.SQL, req.Limit)
	case "prepare-mount":
		result.SQL, err = eng.PrepareRemoteFileMountSQL(req.Source, req.FileName, req.Path)
	case "mount":
		err = eng.MountRemoteFileSource(ctx, req.Source, req.FileName, req.Path)
	case "create-view":
		err = eng.CreateResultView(ctx, req.ID, req.SQL)
	case "count":
		result.Count, err = eng.ResultRowCount(ctx, req.ID)
	case "schema":
		result.Schema, err = eng.ResultSchema(ctx, req.ID)
	case "export-result":
		err = eng.ExportResult(ctx, req.ID, req.Format, req.Path)
	case "drop-view":
		err = eng.DropResult(ctx, req.ID)
	case "tables":
		result.Tables, err = eng.GetTablesContext(ctx, req.Source)
	case "describe":
		result.Columns, err = eng.DescribeTable(ctx, req.Source)
	case "stats":
		result.Stats, err = eng.GetSourceStats(ctx, req.Source)
	case "export-source":
		err = eng.ExportSourceTable(ctx, req.Source, req.Format, req.Path)
	case "import":
		err = eng.ImportUploadedFile(ctx, req.ID, req.FileName, req.Path)
	case "register-upload":
		err = eng.RegisterUploadedFile(req.ID, req.FileName, req.Path)
	case "drop-upload":
		err = eng.DropUploadedFile(ctx, req.ID)
	case "validate":
		err = eng.ValidateQuery(ctx, req.SQL)
	default:
		err = fmt.Errorf("unknown compute operation %q", req.Op)
	}
	// Also return an authoritative snapshot with every response, including
	// failed operations and Arrow streams, before the caller releases its gate.
	statuses, _ := json.Marshal(eng.SourceStatuses())
	w.Header().Set(sourceStatusesHeader, string(statuses))
	if reader == nil || err != nil {
		if reader != nil {
			reader.Release()
		}
		writeResponse(w, result, err)
		return
	}
	defer reader.Release()
	w.Header().Set("Content-Type", "application/vnd.apache.arrow.stream")
	w.Header().Set("Trailer", completeTrailer)
	writer := ipc.NewWriter(w, ipc.WithSchema(reader.Schema()))
	for reader.Next() {
		if err := writer.Write(reader.Record()); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	if reader.Err() != nil || writer.Close() != nil {
		panic(http.ErrAbortHandler)
	}
	w.Header().Set(completeTrailer, "1")
}

func writeResponse(w http.ResponseWriter, result response, err error) {
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		result.Error = err.Error()
		w.WriteHeader(http.StatusUnprocessableEntity)
	}
	if err := json.NewEncoder(w).Encode(result); err != nil {
		panic(http.ErrAbortHandler)
	}
}
