package sources

import (
	"context"
	"database/sql"
	"fmt"
)

// Read catalogs in bulk: exploring a source must not scan or count its data.
const postgresExplorationColumnsSQL = `
	SELECT n.nspname::text, c.relname::text, a.attname::text,
	       pg_catalog.format_type(a.atttypid, a.atttypmod)::text
	FROM pg_catalog.pg_class c
	JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	LEFT JOIN pg_catalog.pg_attribute a
	  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
	WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
	  AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
	  AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
	ORDER BY n.nspname, c.relname, a.attnum
`

// Pair composite foreign-key columns by their position in conkey/confkey.
// Constraint OIDs distinguish repeated constraint names across schemas/tables.
const postgresExplorationRelationshipsSQL = `
	SELECT con.oid::text, con.conname::text,
	       ns.nspname::text, src.relname::text,
	       nt.nspname::text, dst.relname::text,
	       a.attname::text, b.attname::text
	FROM pg_catalog.pg_constraint con
	JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
	JOIN pg_catalog.pg_namespace ns ON ns.oid = src.relnamespace
	JOIN pg_catalog.pg_class dst ON dst.oid = con.confrelid
	JOIN pg_catalog.pg_namespace nt ON nt.oid = dst.relnamespace
	CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS pos(i)
	JOIN pg_catalog.pg_attribute a ON a.attrelid = src.oid AND a.attnum = con.conkey[pos.i]
	JOIN pg_catalog.pg_attribute b ON b.attrelid = dst.oid AND b.attnum = con.confkey[pos.i]
	WHERE con.contype = 'f'
	ORDER BY ns.nspname, src.relname, con.oid, pos.i
`

func (p *postgresAdapter) ExploreSchema(ctx context.Context) (*SourceExploration, error) {
	result := &SourceExploration{
		Tables:        []ExplorationTable{},
		Relationships: []ExplorationRelationship{},
	}
	err := withIsolatedCatalog(ctx, postgresStartupSQL, postgresAttachSQL(isolatedCatalogName, p.connection), func(db *sql.DB) error {
		query := func(statement string) (*sql.Rows, error) {
			return db.QueryContext(ctx, "SELECT * FROM postgres_query("+sqlSingleQuoted(isolatedCatalogName)+", "+sqlSingleQuoted(statement)+")")
		}
		rows, err := query(postgresExplorationColumnsSQL)
		if err != nil {
			return fmt.Errorf("read Postgres columns: %w", err)
		}
		tableIndexes := make(map[string]int)
		for rows.Next() {
			var schema, name string
			var columnName, columnType sql.NullString
			if err := rows.Scan(&schema, &name, &columnName, &columnType); err != nil {
				rows.Close()
				return err
			}
			tableRef := p.sourceName + "." + schema + "." + name
			index, exists := tableIndexes[tableRef]
			if !exists {
				index = len(result.Tables)
				tableIndexes[tableRef] = index
				result.Tables = append(result.Tables, ExplorationTable{
					TableRef: tableRef, Schema: schema, Name: name, Columns: []ExplorationColumn{},
				})
			}
			if columnName.Valid {
				result.Tables[index].Columns = append(result.Tables[index].Columns, ExplorationColumn{Name: columnName.String, Type: columnType.String})
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}

		rows, err = query(postgresExplorationRelationshipsSQL)
		if err != nil {
			return fmt.Errorf("read Postgres foreign keys: %w", err)
		}
		defer rows.Close()
		relationshipIndexes := make(map[string]int)
		for rows.Next() {
			var oid, name, fromSchema, fromName, toSchema, toName, column, referencedColumn string
			if err := rows.Scan(&oid, &name, &fromSchema, &fromName, &toSchema, &toName, &column, &referencedColumn); err != nil {
				return err
			}
			fromRef := p.sourceName + "." + fromSchema + "." + fromName
			toRef := p.sourceName + "." + toSchema + "." + toName
			if _, exists := tableIndexes[fromRef]; !exists {
				continue
			}
			if _, exists := tableIndexes[toRef]; !exists {
				continue
			}
			index, exists := relationshipIndexes[oid]
			if !exists {
				index = len(result.Relationships)
				relationshipIndexes[oid] = index
				result.Relationships = append(result.Relationships, ExplorationRelationship{
					Name: name, FromTable: fromRef, ToTable: toRef, Columns: []string{}, ReferencedColumns: []string{},
				})
			}
			result.Relationships[index].Columns = append(result.Relationships[index].Columns, column)
			result.Relationships[index].ReferencedColumns = append(result.Relationships[index].ReferencedColumns, referencedColumn)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
