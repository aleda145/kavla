package demo

import _ "embed"

//go:embed titanic.kavla
var titanicArchive []byte

//go:embed titanic.duckdb
var titanicDatabase []byte

func TitanicArchive() []byte {
	return titanicArchive
}

func TitanicDatabase() []byte {
	return titanicDatabase
}
