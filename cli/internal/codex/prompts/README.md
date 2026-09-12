These are the full prompts from `kavla-main/tldraw-sync-cloudflare/worker/dataSocket/dagPrompt.ts`, expanded into text and embedded into the local Codex client by `../prompts.go`:

- `agent.txt`: `buildDagOrchestratorSystemPrompt`.
- `sql.txt`: `buildSQLAgentSystemPrompt`.
- `lens.txt`: `buildLensWidgetSystemPrompt`, including the complete `getLensVizCatalogPrompt`.
- `layout.txt`: the complete layout planner prompt from the original Codex port in `codex_branch.txt`. The current `kavla-main` DAG runtime places artifacts in the browser and has no separate layout model prompt.

Keep the original analysis, visualization, styling, and editing guidance intact when updating these files. The local integration needs these adaptations:

- Codex uses native `kavla` tool calls and chat responses instead of JSON event envelopes.
- Canvas shape IDs replace the cloud artifact catalog's IDs; argument names match the actual dynamic tool schemas.
- Structured summaries use `create_summary` rather than a `final_answer` event with `display: "summary"`.
- Focused generators return flat JSON objects consumed by `Client.Generate`; SQL is under `sql` rather than `finalAnswer`.
- Lens requires a query-backed source and has a 10,000-row input cap. Its presentation SQL runs over those supplied rows, not arbitrary canvas tables. The prompts describe these actual runtime constraints.
- `update_lens` may omit `visualPrompt`, passing the full user request through to the generator as in the original app.
- External network requests are allowed without a domain allowlist. Browser CORS, resource policies, and mixed-content rules still apply.
- The local run budget, bounded repairs, and terminal failures remain enforced. Restoring the prompts must not reintroduce automatic retry runs.

The original cloud prompts' transport instructions have been translated to the corresponding local operations rather than left as contradictory instructions alongside a second shortened prompt.

Keep renderer selection and visualization guidance aligned with kavla-main. It exposes MapLibre as a library option,
not a map recipe component. Do not add dataset-specific recipes, preferred basemap URLs, or library mandates to
address individual generated Lens failures; fix runtime issues in code and handle specific visual requests through
the user's prompt. Keep additional OSS runtime instructions concise.
