package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	kavlaconfig "github.com/aleda145/kavla/cli/internal/config"
)

const (
	DefaultAppURL  = "https://app.kavla.dev"
	DefaultAuthURL = "https://auth.kavla.dev"
	DefaultAPIURL  = "https://app.kavla.dev"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type ValidationResult struct {
	User  User
	Token string
}

func GetTokenExpiry(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid JWT")
	}

	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("decode JWT payload: %w", err)
	}

	var claims struct {
		ExpiresAt int64 `json:"exp"`
	}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return time.Time{}, fmt.Errorf("decode JWT claims: %w", err)
	}
	if claims.ExpiresAt == 0 {
		return time.Time{}, fmt.Errorf("JWT has no exp claim")
	}
	return time.Unix(claims.ExpiresAt, 0), nil
}

func ValidateToken(authURL, token string) (*ValidationResult, error) {
	endpoint := strings.TrimRight(authURL, "/") + "/api/collections/users/auth-refresh"
	request, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", token)

	response, err := httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("could not reach Kavla authentication: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token is invalid or expired")
	}

	var body struct {
		Record User   `json:"record"`
		Token  string `json:"token"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("parse authentication response: %w", err)
	}
	if strings.TrimSpace(body.Token) == "" {
		return nil, fmt.Errorf("authentication response did not include a refreshed token")
	}
	return &ValidationResult{User: body.Record, Token: body.Token}, nil
}

func SaveToken(token string) error {
	config, err := kavlaconfig.LoadConfigAllowMissing()
	if err != nil {
		return err
	}
	config.Token = token
	return kavlaconfig.SaveConfig(config)
}
