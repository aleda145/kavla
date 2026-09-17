package agent

func dynamicTools() []map[string]interface{} {
	tools := []map[string]interface{}{
		tool("get_canvas_context", "List the data sources, SQL queries, query results, charts, and notes currently on the Kavla canvas.", map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"shapeIds": map[string]interface{}{"type": "array", "items": map[string]string{"type": "string"}},
			},
			"additionalProperties": false,
		}),
		tool("create_query", "Create and execute ONE analytical operation reading the immediate sourceShapeId's table. No CTEs or subqueries. Use HAVING/QUALIFY sparingly for simple result filters. Split combined operations into chained nodes; reuse cleaned inputs.", objectSchema(map[string]interface{}{
			"sourceShapeId": map[string]string{"type": "string"},
			"name":          map[string]string{"type": "string"},
			"sql":           map[string]string{"type": "string"},
			"layout":        layoutSchema(),
		}, "sourceShapeId", "sql")),
		tool("run_query", "Execute an SQL query shape that already exists visibly on the Kavla canvas. This cannot accept new SQL; use create_query for new work and update_query to correct existing SQL.", objectSchema(map[string]interface{}{
			"shapeId": map[string]string{"type": "string"},
		}, "shapeId")),
		tool("update_query", "Edit or repair ONE operation in an existing query and execute it. No CTEs or subqueries. Use HAVING/QUALIFY sparingly for simple result filters. Keep repairs in place; new analytical operations belong in new downstream nodes.", objectSchema(map[string]interface{}{
			"shapeId": map[string]string{"type": "string"},
			"name":    map[string]string{"type": "string"},
			"sql":     map[string]string{"type": "string"},
		}, "shapeId", "sql")),
		tool("create_chart", "Create a Kavla chart from a query shape. Supported chart types are scatter, line, bar, and area.", objectSchema(map[string]interface{}{
			"sourceShapeId": map[string]string{"type": "string"},
			"name":          map[string]string{"type": "string"},
			"chartType":     map[string]interface{}{"type": "string", "enum": []string{"scatter", "line", "bar", "area"}},
			"x":             map[string]string{"type": "string"},
			"y":             map[string]string{"type": "string"},
			"color":         map[string]string{"type": "string"},
            "yAxisScale": map[string]interface{}{"type":"string","enum":[]string{"default","auto","zero"}},
            "isStacked": map[string]string{"type":"boolean"},
            "limit": map[string]interface{}{"type":[]string{"integer","null"},"minimum":1},
            "w": map[string]string{"type":"number"}, "h": map[string]string{"type":"number"},
			"layout":        layoutSchema(),
		}, "sourceShapeId", "chartType", "x", "y")),
		tool("create_note", "Create a short Kavla canvas note near an optional anchor shape.", objectSchema(map[string]interface{}{
			"anchorShapeId": map[string]string{"type": "string"},
			"text":          map[string]string{"type": "string"},
			"layout":        layoutSchema(),
		}, "text")),
		tool("update_chart", "Edit an existing chart in place. Keep its source query, position, and size. Omitted settings stay unchanged; use color: null to remove grouping and limit: null to remove the row limit.", objectSchema(map[string]interface{}{
			"shapeId":       map[string]string{"type": "string"},
			"name":          map[string]string{"type": "string"},
			"chartType":     map[string]interface{}{"type": "string", "enum": []string{"scatter", "line", "bar", "area"}},
			"x":             map[string]string{"type": "string"},
			"y":             map[string]string{"type": "string"},
			"color":         map[string]interface{}{"type": []string{"string", "null"}},
			"yAxisScale":    map[string]interface{}{"type": "string", "enum": []string{"default", "auto", "zero"}},
			"isStacked":     map[string]string{"type": "boolean"},
			"limit":         map[string]interface{}{"type": []string{"integer", "null"}, "minimum": 1},
		}, "shapeId")),
		tool("update_note", "Replace the text of an existing note in place, preserving its position, size, and style. Supply the complete replacement text, up to 4000 characters.", objectSchema(map[string]interface{}{
			"shapeId": map[string]string{"type": "string"},
			"text":    map[string]interface{}{"type": "string", "minLength": 1, "maxLength": 4000},
		}, "shapeId", "text")),
        tool("compute_column_profiles", "Read or compute deterministic column profiles on a source or query. This updates the shape's profiles and records the operation without creating a SQL node. It is not for filtered or cross-column analysis.", objectSchema(map[string]interface{}{
         "shapeId": map[string]string{"type":"string"}, "columns": map[string]interface{}{"type":"array","items":map[string]string{"type":"string"}},
        }, "shapeId")),
        tool("create_lens", "Create a persistent custom visualization, map, globe, or Lens. A focused generator supplies its React code and presentation SQL. Existing query, result, chart, or Lens shapes may be used as the source.", objectSchema(map[string]interface{}{
         "sourceShapeId": map[string]string{"type":"string"}, "visualPrompt": map[string]string{"type":"string"}, "name": map[string]string{"type":"string"}, "dataIntent": map[string]string{"type":"string"}, "w": map[string]string{"type":"number"}, "h": map[string]string{"type":"number"}, "layout": layoutSchema(),
        }, "sourceShapeId", "visualPrompt")),
        tool("update_lens", "Edit or repair an existing Lens in place using its current code, data, and error. Use for visual or presentational changes. Do not create unrelated query shapes for a Lens edit.", objectSchema(map[string]interface{}{
         "shapeId": map[string]string{"type":"string"}, "visualPrompt": map[string]string{"type":"string"}, "dataIntent": map[string]string{"type":"string"},
        }, "shapeId")),
        tool("create_summary", "Save a completed analytical write-up on the canvas. Use for requested reports or substantive multi-step conclusions; keep lightweight answers in chat. Cite existing evidence shapes.", objectSchema(map[string]interface{}{
         "question": map[string]string{"type":"string"}, "answer": map[string]string{"type":"string"}, "name": map[string]string{"type":"string"},
         "sections": map[string]interface{}{"type":"array","items":objectSchema(map[string]interface{}{"title":map[string]string{"type":"string"},"body":map[string]string{"type":"string"}},"title","body")},
         "artifacts": map[string]interface{}{"type":"array","maxItems":6,"items":objectSchema(map[string]interface{}{"shapeId":map[string]string{"type":"string"},"title":map[string]string{"type":"string"},"note":map[string]string{"type":"string"}},"shapeId","title","note")}, "layout": layoutSchema(),
        }, "question", "answer", "sections", "artifacts")),
	}
	return []map[string]interface{}{{
		"type":        "namespace",
		"name":        "kavla",
		"description": "Inspect and change the current Kavla analytics canvas. These are the only tools you may use.",
		"tools":       tools,
	}}
}

func tool(name, description string, schema map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"type":        "function",
		"name":        name,
		"description": description,
		"inputSchema": schema,
	}
}

func objectSchema(properties map[string]interface{}, required ...string) map[string]interface{} {
	return map[string]interface{}{
		"type":                 "object",
		"properties":           properties,
		"required":             required,
		"additionalProperties": false,
	}
}

func layoutSchema() map[string]interface{} {
	return map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"branch": map[string]string{"type": "string", "description": "Query lane label. Use main for the primary chain, a short distinct label for each parallel comparison or diagnostic branch. Inherited from the input when omitted; reuse the label along a branch and use main when rejoining it."},
			"role": map[string]interface{}{"type": "string", "enum": []string{"analysis", "diagnostic"}, "description": "Query purpose: analysis for the answer-producing path, diagnostic for preliminary checks/samples/outliers. Inherited from the input when omitted. Diagnostics are placed separately from the main analysis."},
			"parentShapeId": map[string]string{"type": "string"},
			"placement": map[string]interface{}{
				"type": "string",
				"enum": []string{"right", "below", "above", "summary"},
			},
			"order": map[string]interface{}{"type": "number", "minimum": 0, "maximum": 20},
		},
		"additionalProperties": false,
	}
}
