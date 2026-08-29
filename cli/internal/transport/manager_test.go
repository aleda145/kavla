package transport

import "testing"

func TestHostedSourceListDoesNotExposeConnectionErrors(t *testing.T) {
	sources := []map[string]interface{}{
		{
			"name":      "warehouse",
			"type":      "postgres",
			"available": false,
			"error":     "could not connect to postgres://user:password@db.internal/warehouse",
		},
	}
	hosted := hostedSourceList(sources)
	if hosted[0]["error"] == sources[0]["error"] {
		t.Fatal("hosted source list exposed the local connection error")
	}
	if hosted[0]["name"] != "warehouse" || hosted[0]["type"] != "postgres" {
		t.Fatalf("hosted source metadata was not preserved: %+v", hosted[0])
	}
}
