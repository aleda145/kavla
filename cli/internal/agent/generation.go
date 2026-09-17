package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

func parseGeneration(mode, text string) (map[string]interface{}, error) {
 text = strings.TrimSpace(text)
 if strings.HasPrefix(text, "```") {
  if start := strings.Index(text, "\n"); start >= 0 { text = text[start+1:] }
  text = strings.TrimSpace(strings.TrimSuffix(text, "```"))
 }
 var result map[string]interface{}
 if err := json.Unmarshal([]byte(text), &result); err != nil { return nil, fmt.Errorf("invalid %s generation response: %w", mode, err) }
 key := "sql"
 if mode == "lens" { key = "code" }
 value, _ := result[key].(string)
 if strings.TrimSpace(value) == "" { return nil, fmt.Errorf("generated %s is missing %s", mode, key) }
 return result, nil
}

