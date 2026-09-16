package codex

import _ "embed"

// Full kavla-main prompts, adapted to the local tool protocol and documented runtime differences.
// Keep the prose in text files so prompt updates do not require escaping code examples.

//go:embed prompts/agent.txt
var developerInstructions string

//go:embed prompts/sql.txt
var sqlDeveloperInstructions string

//go:embed prompts/lens.txt
var lensDeveloperInstructions string
