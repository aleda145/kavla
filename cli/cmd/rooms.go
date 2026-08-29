package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var hostedHTTPClient = &http.Client{Timeout: 15 * time.Second}

type Room struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func fetchRooms(authURL, token string) ([]Room, error) {
	endpoint := strings.TrimRight(authURL, "/") + "/api/kavla/rooms/list"
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", token)
	response, err := hostedHTTPClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("could not reach Kavla authentication: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("login expired; run 'kavla login' again")
	}
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("list canvases (HTTP %d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	var rooms []Room
	if err := json.NewDecoder(response.Body).Decode(&rooms); err != nil {
		return nil, fmt.Errorf("parse canvas list: %w", err)
	}
	return rooms, nil
}

func checkRoomOwnership(authURL, token, roomID, userID string) error {
	endpoint := strings.TrimRight(authURL, "/") + "/api/collections/rooms/records/" + url.PathEscape(roomID)
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", token)
	response, err := hostedHTTPClient.Do(request)
	if err != nil {
		return fmt.Errorf("could not reach Kavla authentication: %w", err)
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusNotFound:
		return fmt.Errorf("canvas not found; check its ID and your access")
	case http.StatusUnauthorized:
		return fmt.Errorf("login expired; run 'kavla login' again")
	case http.StatusForbidden:
		return fmt.Errorf("you do not have access to this canvas")
	case http.StatusOK:
	default:
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("check canvas access (HTTP %d): %s", response.StatusCode, strings.TrimSpace(string(body)))
	}

	var room struct {
		Owner string `json:"owner"`
	}
	if err := json.NewDecoder(response.Body).Decode(&room); err != nil {
		return fmt.Errorf("parse canvas access: %w", err)
	}
	if room.Owner != "" && userID != "" && room.Owner != userID {
		return fmt.Errorf("only the canvas owner can connect CLI sources; collaborators cannot attach a CLI")
	}
	return nil
}

func pickRoom(rooms []Room) int {
	labels := make([]string, 0, len(rooms))
	for _, room := range rooms {
		label := room.Name
		if strings.TrimSpace(label) == "" {
			label = room.ID
		}
		labels = append(labels, label)
	}
	selected, err := chooseOptionInteractive("Select a canvas:", labels)
	if err != nil {
		fmt.Println("Interactive selection is unavailable; selecting the first canvas.")
		return 0
	}
	return selected
}
