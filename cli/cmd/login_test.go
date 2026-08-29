package cmd

import "testing"

func TestLoginPageURLPreservesExistingPathAndQuery(t *testing.T) {
	loginPage, err := loginPageURL("https://app.kavla.dev/base?channel=cli", 43123, "state-value")
	if err != nil {
		t.Fatalf("loginPageURL returned error: %v", err)
	}
	want := "https://app.kavla.dev/base/auth?channel=cli&cli_port=43123&cli_state=state-value&mode=login"
	if loginPage != want {
		t.Fatalf("expected %s, got %s", want, loginPage)
	}
}

func TestOriginForURLRejectsWebsocketURL(t *testing.T) {
	if _, err := originForURL("wss://app.kavla.dev"); err == nil {
		t.Fatal("expected websocket URL to be rejected")
	}
}
