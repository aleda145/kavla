These prompts originated in `kavla-main/tldraw-sync-cloudflare/worker/dataSocket/dagPrompt.ts`, were expanded into text, and are embedded into the local agent runtime by `../prompts.go`:

- `agent.txt`: `buildDagOrchestratorSystemPrompt`.
- `sql.txt`: `buildSQLAgentSystemPrompt`.
- `lens.txt`: `buildLensWidgetSystemPrompt`, including the complete `getLensVizCatalogPrompt`.

Preserve the visualization, styling, and editing guidance when updating these files. The analytical workflow explicitly favors question-driven inspection, visible diagnostics, justified cleaning, and small chained query nodes. Once cleaning exists, subsequent analysis of that population must reuse the cleaned node or its descendants. Outliers and nulls are not automatic exclusions. The local integration also needs these adaptations:

- The agent uses native `kavla` tool calls and chat responses instead of JSON event envelopes.
- Canvas shape IDs replace the cloud artifact catalog's IDs; argument names match the actual dynamic tool schemas.
- Structured summaries use `create_summary` rather than a `final_answer` event with `display: "summary"`.
- Focused generators return flat JSON objects consumed by `Runtime.Generate`; SQL is under `sql` rather than `finalAnswer`.
- Lens requires a query-backed source and loads its complete result without a row cap. Its presentation SQL runs over those supplied rows, not arbitrary canvas tables. Generation context includes only a small sample for the model; validation and rendering use the complete result. The prompts describe these actual runtime constraints.
- `update_lens` may omit `visualPrompt`, passing the full user request through to the generator as in the original app.
- External network requests are allowed without a domain allowlist. Browser CORS, resource policies, and mixed-content rules still apply.
- The local run budget, bounded repairs, and terminal failures remain enforced. Restoring the prompts must not reintroduce automatic retry runs.

The original cloud prompts' transport instructions have been translated to the corresponding local operations rather than left as contradictory instructions alongside a second shortened prompt.

Keep renderer selection and visualization guidance aligned with kavla-main. It exposes MapLibre as a library option,
not a map recipe component. Do not add dataset-specific recipes, preferred basemap URLs, or library mandates to
address individual generated Lens failures; fix runtime issues in code and handle specific visual requests through
the user's prompt. Keep additional OSS runtime instructions concise.
