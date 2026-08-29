package auth

import (
	"encoding/base64"
	"testing"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

func TestGetTokenExpiryDecodesURLSafeJWT(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":1893456000,"value":"-_"}`))
	expiry, err := GetTokenExpiry("header." + payload + ".signature")
	if err != nil {
		t.Fatalf("GetTokenExpiry returned error: %v", err)
	}
	want := time.Unix(1893456000, 0)
	if !expiry.Equal(want) {
		t.Fatalf("expected %s, got %s", want, expiry)
	}
}

func TestSaveTokenPreservesSourcesAndHostedURLs(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	config := &kavlaconfig.Config{
		APIURL:  "https://worker.example.test",
		AuthURL: "https://auth.example.test",
		AppURL:  "https://app.example.test",
		Sources: map[string]kavlaconfig.SourceConfig{
			"warehouse": {Type: "duckdb", Connection: "/data/warehouse.duckdb"},
		},
	}
	if err := kavlaconfig.SaveConfig(config); err != nil {
		t.Fatalf("SaveConfig returned error: %v", err)
	}
	if err := SaveToken("new-token"); err != nil {
		t.Fatalf("SaveToken returned error: %v", err)
	}

	loaded, err := kavlaconfig.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig returned error: %v", err)
	}
	if loaded.Token != "new-token" || loaded.APIURL != config.APIURL || len(loaded.Sources) != 1 {
		t.Fatalf("SaveToken did not preserve config: %+v", loaded)
	}
}
