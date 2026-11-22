// Standalone test/benchmark bridge, never linked into the Kavla application.
// Uses the same Session.Compute, result views and Arrow encoder as the backend.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/aleda145/kavla/cli/internal/session"
	"github.com/apache/arrow/go/v14/arrow/array"
	"github.com/apache/arrow/go/v14/arrow/ipc"
)

type request struct {
	ID        int    `json:"id"`
	SQL       string `json:"sql"`
	Operation string `json:"operation"`
	ShapeID   string `json:"shapeId"`
	Offset    int    `json:"offset"`
	Limit     int    `json:"limit"`
}

func main() {
	s := session.New(nil)
	if err := s.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer s.Close()
	if len(os.Args) == 3 && os.Args[1] == "serve" {
		mux := http.NewServeMux()
		mux.HandleFunc("POST /query", func(w http.ResponseWriter, r *http.Request) {
			// Test-only localhost bridge. Production uses the authenticated,
			// document-scoped /api/session/compute and query-result endpoints.
			var req request
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			start := time.Now()
			if req.Operation == "create" {
				result, err := s.RunQuery(r.Context(), nil, runner.QueryRequest{SQL: req.SQL, ShapeId: req.ShapeID, QueryName: req.ShapeID})
				if err != nil {
					http.Error(w, err.Error(), 422)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(result)
				return
			}
			var reader array.RecordReader
			var err error
			if req.Operation == "page" {
				reader, err = s.QueryResultPage(r.Context(), req.ShapeID, req.Offset, req.Limit)
			} else {
				reader, err = s.Compute(r.Context(), req.SQL)
			}
			if err != nil {
				http.Error(w, err.Error(), 422)
				return
			}
			defer reader.Release()
			queryMS := float64(time.Since(start).Microseconds()) / 1000
			start = time.Now()
			var buffer bytes.Buffer
			writer := ipc.NewWriter(&buffer, ipc.WithSchema(reader.Schema()))
			for reader.Next() {
				if err = writer.Write(reader.Record()); err != nil {
					break
				}
			}
			if err == nil {
				err = reader.Err()
			}
			if closeErr := writer.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.Header().Set("Content-Type", "application/vnd.apache.arrow.stream")
			w.Header().Set("Server-Timing", fmt.Sprintf("query;dur=%.3f,serialize;dur=%.3f", queryMS, float64(time.Since(start).Microseconds())/1000))
			w.Write(buffer.Bytes())
		})
		mux.Handle("/", http.FileServer(http.Dir(os.Args[2])))
		fmt.Fprintln(os.Stderr, "Headless visualization harness: http://127.0.0.1:5189/browser-harness.html")
		if err := http.ListenAndServe("127.0.0.1:5189", mux); err != nil {
			panic(err)
		}
		return
	}
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 4096), 8*1024*1024)
	output := json.NewEncoder(os.Stdout)
	for input.Scan() {
		var req request
		if err := json.Unmarshal(input.Bytes(), &req); err != nil {
			panic(err)
		}
		start := time.Now()
		var reader array.RecordReader
		var result *session.QueryResult
		var err error
		switch req.Operation {
		case "create":
			result, err = s.RunQuery(context.Background(), nil, runner.QueryRequest{
				SQL: req.SQL, ShapeId: req.ShapeID, QueryName: req.ShapeID,
			})
		case "page":
			reader, err = s.QueryResultPage(context.Background(), req.ShapeID, req.Offset, req.Limit)
		default:
			reader, err = s.Compute(context.Background(), req.SQL)
		}
		queryMS := float64(time.Since(start).Microseconds()) / 1000
		response := map[string]interface{}{"id": req.ID, "queryMs": queryMS}
		if err != nil {
			response["error"] = err.Error()
		} else if result != nil {
			response["rowCount"] = result.RowCount
		} else {
			start = time.Now()
			var buffer bytes.Buffer
			writer := ipc.NewWriter(&buffer, ipc.WithSchema(reader.Schema()))
			for reader.Next() {
				if err = writer.Write(reader.Record()); err != nil {
					break
				}
			}
			if err == nil {
				err = reader.Err()
			}
			if closeErr := writer.Close(); err == nil {
				err = closeErr
			}
			reader.Release()
			if err != nil {
				response["error"] = err.Error()
			} else {
				response["ipc"] = buffer.Bytes()
				response["serializationMs"] = float64(time.Since(start).Microseconds()) / 1000
			}
		}
		if err := output.Encode(response); err != nil {
			panic(err)
		}
	}
	if err := input.Err(); err != nil {
		panic(err)
	}
}
