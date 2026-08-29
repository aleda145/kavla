package cmd

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDesktopLandingHandlerNavigatesToLocalApp(t *testing.T) {
	launchURL := "http://127.0.0.1:43210/?name=one&view=two"
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()

	desktopLandingHandler(launchURL).ServeHTTP(response, request)

	result := response.Result()
	defer result.Body.Close()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		t.Fatal(err)
	}
	if result.StatusCode != http.StatusOK {
		t.Fatalf("landing status = %d, want %d", result.StatusCode, http.StatusOK)
	}
	if result.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("landing page must not be cached")
	}
	if !strings.Contains(string(body), `window.location.replace("http://127.0.0.1:43210/?name=one\u0026view=two")`) {
		t.Fatalf("landing page does not safely navigate to launch URL: %s", body)
	}
}
