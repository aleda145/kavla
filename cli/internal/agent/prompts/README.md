These compact prompts are embedded by ../prompts.go and shared by the Codex and API runtimes.

- agent.txt: choose analytical steps, write and repair SQL directly, manage canvas artifacts, interpret results.
- lens.txt: implement one visualization with the actual runtime props and rendering contract.

The prompts originated in kavla-main's worker/dataSocket/dagPrompt.ts and are now maintained as concise local instructions, not verbatim copies.

Keep each rule with the agent responsible for it. Tool schemas own argument documentation. Replace obsolete guidance instead of appending exceptions and repeated examples.

Preserve these contracts when editing:
- Inspect relevant data, justify exclusions, and reuse a visible cleaned node for subsequent analysis. Each analytical query performs one operation; no CTEs or subqueries, including repairs and diagnostics. HAVING/QUALIFY may add a simple result filter when the node stays focused; otherwise use a downstream filter. Separate distinct analytical operations into a visible chain.
- Use native tools/chat and actual canvas IDs. Only Lens generation uses a specialist, returning flat JSON with readable TSX/JSX. SQL execution errors return to the analyst for in-place repair.
- Lens input is uncapped; samples are only context previews. Presentation SQL reads the supplied source, not arbitrary canvas tables.
- Existing Lens edits stay in place. Runtime tool/repair limits are authoritative.
- The main analyst owns presentation incrementally: placement on creation, selective tables/charts, and small move_shapes adjustments informed by actual canvas bounds and arrows. No separate layout agent or final arrangement. Avoid rigid lanes and automatic tables on every query; keep established positions stable.
- Keep Kavla styling, injected library/helper APIs, and the requested key-free OpenFreeMap default.

Prompt edits can change model behavior even when compilation succeeds. Assess actual agent runs before claiming equivalent or improved results.
