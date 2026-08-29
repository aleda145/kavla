package cmd

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"
)

// desktopLandingHandler gives Wails a tiny first page that navigates its WebView
// to the loopback application. Keeping the existing loopback origin preserves
// same-origin HTTP access and cross-origin isolation while avoiding an external
// browser window.
func desktopLandingHandler(launchURL string) http.Handler {
	encodedURL, _ := json.Marshal(launchURL)
	page := fmt.Sprintf(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=%s">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Opening Kavla</title>
</head>
<body>
  <p>Opening Kavla…</p>
  <script>window.location.replace(%s)</script>
</body>
</html>`, html.EscapeString(launchURL), encodedURL)

	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(page))
	})
}
