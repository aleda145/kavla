package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

func parseLensGeneration(text string) (map[string]interface{}, error) {
 text = strings.TrimSpace(text)
 if strings.HasPrefix(text, "```") {
  if start := strings.Index(text, "\n"); start >= 0 { text = text[start+1:] }
  text = strings.TrimSpace(strings.TrimSuffix(text, "```"))
 }
 var result map[string]interface{}
 if err := json.Unmarshal([]byte(text), &result); err != nil { return nil, fmt.Errorf("invalid Lens generation response: %w", err) }
 value, _ := result["code"].(string)
 if strings.TrimSpace(value) == "" { return nil, fmt.Errorf("generated Lens is missing code") }
 return result, nil
}
