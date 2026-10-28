package localapp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/nikolalohinski/gonja/v2"
	"github.com/nikolalohinski/gonja/v2/config"
	"github.com/nikolalohinski/gonja/v2/exec"
	"github.com/nikolalohinski/gonja/v2/loaders"
	"gopkg.in/yaml.v3"
)

type dbtCompileModel struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	RefName string  `json:"refName"`
	Package string  `json:"package"`
	SQL     *string `json:"sql"`
	Source  string  `json:"source"`
	Table   string  `json:"table"`
}

type dbtCompileRequest struct {
	BindingID   string            `json:"bindingId"`
	SQL         string            `json:"sql"`
	Models      []dbtCompileModel `json:"models"`
	Required    []string          `json:"required"`
	Macros      []string          `json:"macros"`
	ProjectYAML string            `json:"projectYaml"`
}

type dbtCompileResponse struct {
	SQL          string              `json:"sql"`
	Models       map[string]string   `json:"models"`
	Dependencies map[string][]string `json:"dependencies"`
}

type dbtRenderBuffer struct {
	strings.Builder
	ctx context.Context
}

func (b *dbtRenderBuffer) Write(data []byte) (int, error) {
	if err := b.ctx.Err(); err != nil {
		return 0, err
	}
	if b.Len()+len(data) > 2<<20 {
		return 0, fmt.Errorf("rendered dbt SQL exceeds 2 MiB")
	}
	return b.Builder.Write(data)
}

func (s *Server) handleDBTCompile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 24<<20)
	var request dbtCompileRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, 400, err)
		return
	}
	dbtMu.Lock()
	_, bindings, err := dbtBindings()
	binding := bindings[s.document.Path()]
	dbtMu.Unlock()
	if err != nil {
		writeAPIError(w, 500, err)
		return
	}
	if binding.ID == "" || binding.ID != request.BindingID {
		writeAPIError(w, 409, fmt.Errorf("connect this dbt project before running its models"))
		return
	}
	result, err := compileDBTCanvas(r.Context(), request)
	if err != nil {
		writeAPIError(w, 422, fmt.Errorf("dbt preview: %w", err))
		return
	}
	dbtJSON(w, result)
}

// Compile the current canvas snapshot, never compiled files from disk. ref and
// source resolve to canvas relations; materializations/hooks are not executed.
func compileDBTCanvas(ctx context.Context, request dbtCompileRequest) (*dbtCompileResponse, error) {
	if len(request.Models) > 2000 {
		return nil, fmt.Errorf("too many canvas models")
	}
	var project struct {
		Name string         `yaml:"name"`
		Vars map[string]any `yaml:"vars"`
	}
	if err := yaml.Unmarshal([]byte(request.ProjectYAML), &project); err != nil {
		return nil, fmt.Errorf("dbt_project.yml: %w", err)
	}
	if project.Name == "" {
		return nil, fmt.Errorf("dbt_project.yml needs a project name")
	}
	result := &dbtCompileResponse{Models: map[string]string{}, Dependencies: map[string][]string{}}
	byID := make(map[string]dbtCompileModel)
	for _, model := range request.Models {
		if _, exists := byID[model.ID]; exists {
			return nil, fmt.Errorf("duplicate model ID %s", model.ID)
		}
		byID[model.ID] = model
	}
	macros := strings.Join(request.Macros, "\n") + "\n"
	visiting := make(map[string]bool)
	var renderModel func(string) error
	var render func(string, string) (string, error)
	quote := func(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }
	render = func(id, sql string) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		ref := func(args *exec.VarArgs) (string, error) {
			if len(args.Args) < 1 || len(args.Args) > 2 || len(args.KwArgs) > 0 {
				return "", fmt.Errorf("ref expects a model name and optional package; versioned refs need explicit version support")
			}
			pkg, name := project.Name, args.Args[0].String()
			if len(args.Args) == 2 {
				pkg, name = name, args.Args[1].String()
			}
			matches := []dbtCompileModel{}
			for _, candidate := range request.Models {
				if candidate.Source == "" && candidate.RefName == name && candidate.Package == pkg {
					matches = append(matches, candidate)
				}
			}
			// Project identities win over unrelated exploratory nodes with the same display name.
			if len(matches) == 0 && len(args.Args) == 1 {
				for _, candidate := range request.Models {
					if candidate.Source == "" && candidate.RefName == name && candidate.Package == "" {
						matches = append(matches, candidate)
					}
				}
			}
			if len(matches) != 1 {
				return "", fmt.Errorf("ref('%s'): expected one canvas model in %s, found %d", name, pkg, len(matches))
			}
			model := matches[0]
			result.Dependencies[id] = append(result.Dependencies[id], model.ID)
			if err := renderModel(model.ID); err != nil {
				return "", err
			}
			return quote(model.Name), nil
		}
		source := func(group, table string) (string, error) {
			matches := []dbtCompileModel{}
			for _, candidate := range request.Models {
				if candidate.Source == group && candidate.Table == table {
					matches = append(matches, candidate)
				}
			}
			if len(matches) != 1 {
				return "", fmt.Errorf("source('%s', '%s'): expected one source node, found %d", group, table, len(matches))
			}
			result.Dependencies[id] = append(result.Dependencies[id], matches[0].ID)
			return quote(matches[0].Name), nil
		}
		vars := func(args *exec.VarArgs) (any, error) {
			if len(args.Args) < 1 || len(args.Args) > 2 {
				return nil, fmt.Errorf("var expects a name and optional default")
			}
			name := args.Args[0].String()
			if value, ok := project.Vars[name]; ok {
				return value, nil
			}
			if len(args.Args) == 2 {
				return args.Args[1].Interface(), nil
			}
			return nil, fmt.Errorf("missing project variable %s", name)
		}
		environment := *gonja.DefaultEnvironment
		environment.Context = gonja.DefaultContext.Inherit()
		settings := config.New()
		settings.StrictUndefined = true
		settings.KeepTrailingNewline = true
		loader, err := loaders.NewMemoryLoader(map[string]string{"/model.sql": macros + sql})
		if err != nil {
			return "", err
		}
		template, err := exec.NewTemplate("/model.sql", settings, loader, &environment)
		if err != nil {
			return "", err
		}
		values := exec.NewContext(map[string]any{
			"ref": ref, "source": source, "var": vars,
			"config":         func(_ *exec.VarArgs) string { return "" },
			"is_incremental": func() bool { return false },
			"execute":        false,
			"log":            func(_ *exec.VarArgs) string { return "" },
		})
		buffer := &dbtRenderBuffer{ctx: ctx}
		if err := template.Execute(buffer, values); err != nil {
			return "", err
		}
		return strings.TrimSpace(buffer.String()), nil
	}
	renderModel = func(id string) error {
		if _, ok := result.Models[id]; ok {
			return nil
		}
		model, ok := byID[id]
		if !ok {
			return fmt.Errorf("missing canvas model %s", id)
		}
		if model.SQL == nil {
			return nil
		}
		if visiting[id] {
			return fmt.Errorf("circular dbt dependency at %s", model.Name)
		}
		visiting[id] = true
		text, err := render(id, *model.SQL)
		delete(visiting, id)
		if err != nil {
			return fmt.Errorf("%s: %w", model.Name, err)
		}
		result.Models[id] = text
		return nil
	}
	for _, id := range request.Required {
		if err := renderModel(id); err != nil {
			return nil, err
		}
	}
	var err error
	result.SQL, err = render("root", request.SQL)
	if err != nil {
		return nil, err
	}
	return result, nil
}
