package sources

import "context"

type ExplorationColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type ExplorationTable struct {
	TableRef string              `json:"tableRef"`
	Schema   string              `json:"schema"`
	Name     string              `json:"name"`
	Columns  []ExplorationColumn `json:"columns"`
}

type ExplorationRelationship struct {
	Name              string   `json:"name"`
	FromTable         string   `json:"fromTable"`
	ToTable           string   `json:"toTable"`
	Columns           []string `json:"columns"`
	ReferencedColumns []string `json:"referencedColumns"`
}

type SourceExploration struct {
	Tables        []ExplorationTable        `json:"tables"`
	Relationships []ExplorationRelationship `json:"relationships"`
}

type SchemaExplorer interface {
	ExploreSchema(ctx context.Context) (*SourceExploration, error)
}
