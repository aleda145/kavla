These compact prompts are embedded by ../prompts.go and shared by the Codex and API runtimes.

- agent.txt: choose analytical steps, manage canvas artifacts, interpret results.
- sql.txt: implement one SQL step with the supplied source and edit strategy.
- lens.txt: implement one visualization with the actual runtime props and rendering contract.

The prompts originated in kavla-main's worker/dataSocket/dagPrompt.ts and are now maintained as concise local instructions, not verbatim copies.

Keep each rule with the agent responsible for it. Tool schemas own argument documentation. Replace obsolete guidance instead of appending exceptions and repeated examples.

Preserve these contracts when editing:
- Inspect relevant data, justify exclusions, and reuse a visible cleaned node for subsequent analysis. Prefer small chained queries over SQL pipelines.
- Use native tools/chat and actual canvas IDs. Focused generators return flat JSON; Lens code is readable TSX/JSX.
- Lens input is uncapped; samples are only context previews. Presentation SQL reads the supplied source, not arbitrary canvas tables.
- Existing Lens edits stay in place. Runtime tool/repair limits are authoritative.
- Keep Kavla styling, injected library/helper APIs, and the requested key-free OpenFreeMap default.

Prompt edits can change model behavior even when compilation succeeds. Assess actual agent runs before claiming equivalent or improved results.
