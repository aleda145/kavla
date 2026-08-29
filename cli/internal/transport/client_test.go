package transport

import "testing"

func TestWebsocketDialConfigUsesHostedDataSocketAndBearerToken(t *testing.T) {
	client := NewClient("https://app.kavla.dev", "room-123", "secret-token")
	websocketURL, options, err := client.websocketDialConfig()
	if err != nil {
		t.Fatalf("websocketDialConfig returned error: %v", err)
	}
	if websocketURL != "wss://app.kavla.dev/api/data-socket/room-123?clientType=cli" {
		t.Fatalf("unexpected websocket URL: %s", websocketURL)
	}
	if got := options.HTTPHeader.Get("Authorization"); got != "Bearer secret-token" {
		t.Fatalf("unexpected Authorization header: %q", got)
	}
}

func TestWebsocketDialConfigPreservesDeploymentPrefix(t *testing.T) {
	client := NewClient("http://localhost:8787/kavla", "room-123", "token")
	websocketURL, _, err := client.websocketDialConfig()
	if err != nil {
		t.Fatalf("websocketDialConfig returned error: %v", err)
	}
	if websocketURL != "ws://localhost:8787/kavla/api/data-socket/room-123?clientType=cli" {
		t.Fatalf("unexpected websocket URL: %s", websocketURL)
	}
}
