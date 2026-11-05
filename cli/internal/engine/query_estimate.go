package engine

import (
	"context"
	"fmt"
	"strings"

	"github.com/aleda145/kavla/cli/internal/sources"
)

func (e *Engine) EstimateQuery(ctx context.Context, executionEngine, sourceName, query string) (*sources.QueryEstimate, error) {
	return e.estimateQuery(ctx, executionEngine, sourceName, query, false)
}

func (e *Engine) EstimateReadyQuery(ctx context.Context, executionEngine, sourceName, query string) (*sources.QueryEstimate, error) {
	return e.estimateQuery(ctx, executionEngine, sourceName, query, true)
}

func (e *Engine) estimateQuery(ctx context.Context, executionEngine, sourceName, query string, sourceReady bool) (*sources.QueryEstimate, error) {
	executionEngine = strings.TrimSpace(executionEngine)
	sourceName = strings.TrimSpace(sourceName)
	config, ok := e.sourceConfigs[sourceName]
	if !ok || sourceName == "" {
		return nil, fmt.Errorf("query estimation requires a configured source")
	}
	if executionEngine == "" || executionEngine != config.Type {
		return nil, fmt.Errorf("query estimation requires the source's native execution engine")
	}
	adapter, err := e.getAdapterForType(executionEngine)
	if err != nil {
		return nil, err
	}
	if _, ok := adapter.(sources.QueryEstimator); !ok {
		return nil, fmt.Errorf("query estimation is not supported for %s", executionEngine)
	}
	if !sourceReady {
		if err := e.ensureConfiguredSourceHealthy(ctx, sourceName); err != nil {
			return nil, err
		}
	}
	// The concurrent path uses the stateless adapter, avoiding shared maps.
	estimator := adapter.(sources.QueryEstimator)
	return estimator.EstimateQuery(ctx, e.db, sourceName, query)
}
