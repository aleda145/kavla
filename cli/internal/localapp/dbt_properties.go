package localapp

import (
	"fmt"
	"sort"

	"gopkg.in/yaml.v3"
)

type dbtColumnDocumentation struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	DataType    string   `json:"dataType"`
	Tests       []string `json:"tests"`
}

type dbtDocumentation struct {
	Name              string                   `json:"name"`
	Kind              string                   `json:"kind"`
	Source            string                   `json:"source,omitempty"`
	Path              string                   `json:"path"`
	Description       string                   `json:"description"`
	SourceDescription string                   `json:"sourceDescription,omitempty"`
	Tags              []string                 `json:"tags"`
	Tests             []string                 `json:"tests"`
	Materialized      string                   `json:"materialized,omitempty"`
	Columns           []dbtColumnDocumentation `json:"columns"`
}

type dbtProperty struct {
	Name        string         `yaml:"name"`
	Description string         `yaml:"description"`
	DataType    string         `yaml:"data_type"`
	Schema      string         `yaml:"schema"`
	Identifier  string         `yaml:"identifier"`
	Tags        any            `yaml:"tags"`
	Tests       []any          `yaml:"tests"`
	DataTests   []any          `yaml:"data_tests"`
	Config      map[string]any `yaml:"config"`
	Columns     []dbtProperty  `yaml:"columns"`
	Tables      []dbtProperty  `yaml:"tables"`
}

func dbtPropertyTags(value any) []string {
	result := []string{}
	switch tags := value.(type) {
	case string:
		result = append(result, tags)
	case []any:
		for _, tag := range tags {
			if text, ok := tag.(string); ok {
				result = append(result, text)
			}
		}
	}
	return result
}

func dbtPropertyTests(property dbtProperty) []string {
	result := []string{}
	for _, test := range append(append([]any{}, property.Tests...), property.DataTests...) {
		switch value := test.(type) {
		case string:
			result = append(result, value)
		case map[string]any:
			for name := range value {
				result = append(result, name)
			}
		}
	}
	sort.Strings(result)
	return result
}

func dbtPropertyDocumentation(property dbtProperty, kind, file string) dbtDocumentation {
	materialized, _ := property.Config["materialized"].(string)
	doc := dbtDocumentation{Name: property.Name, Kind: kind, Path: file, Description: property.Description,
		Tags:  append(dbtPropertyTags(property.Tags), dbtPropertyTags(property.Config["tags"])...),
		Tests: dbtPropertyTests(property), Materialized: materialized, Columns: []dbtColumnDocumentation{}}
	for _, column := range property.Columns {
		doc.Columns = append(doc.Columns, dbtColumnDocumentation{Name: column.Name, Description: column.Description, DataType: column.DataType, Tests: dbtPropertyTests(column)})
	}
	return doc
}

func dbtProperties(project *dbtProject) {
	for _, file := range project.Files {
		if file.Kind != "properties" {
			continue
		}
		if file.ReadOnly {
			project.Warnings = append(project.Warnings, file.Path+": metadata exceeds the supported file size")
			continue
		}
		var properties struct {
			Models    []dbtProperty `yaml:"models"`
			Seeds     []dbtProperty `yaml:"seeds"`
			Snapshots []dbtProperty `yaml:"snapshots"`
			Analyses  []dbtProperty `yaml:"analyses"`
			Sources   []dbtProperty `yaml:"sources"`
		}
		if err := yaml.Unmarshal([]byte(file.Text), &properties); err != nil {
			project.Warnings = append(project.Warnings, fmt.Sprintf("%s: cannot read dbt metadata: %v", file.Path, err))
			continue
		}
		for _, group := range []struct {
			kind    string
			entries []dbtProperty
		}{{"model", properties.Models}, {"seed", properties.Seeds}, {"snapshot", properties.Snapshots}, {"analysis", properties.Analyses}} {
			for _, property := range group.entries {
				project.Documentation = append(project.Documentation, dbtPropertyDocumentation(property, group.kind, file.Path))
			}
		}
		for _, source := range properties.Sources {
			for _, table := range source.Tables {
				schema, identifier := source.Schema, table.Identifier
				if schema == "" {
					schema = source.Name
				}
				if identifier == "" {
					identifier = table.Name
				}
				project.Sources = append(project.Sources, dbtSourceDefinition{Source: source.Name, Table: table.Name, Schema: schema, Identifier: identifier, Path: file.Path})
				doc := dbtPropertyDocumentation(table, "source", file.Path)
				doc.Source = source.Name
				doc.SourceDescription = source.Description
				doc.Tags = append(append(dbtPropertyTags(source.Tags), dbtPropertyTags(source.Config["tags"])...), doc.Tags...)
				project.Documentation = append(project.Documentation, doc)
			}
		}
	}
}
