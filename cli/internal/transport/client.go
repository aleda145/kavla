package transport

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aleda145/kavla/cli/internal/runner"
	"github.com/google/uuid"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

const maxHostedResultDataSize = 10 * 1024 * 1024

type Client struct {
	workerURL string
	roomID    string
	token     string

	mu              sync.Mutex
	writeMu         sync.Mutex
	connection      *websocket.Conn
	context         context.Context
	pendingRequests map[string]chan map[string]interface{}
}

func NewClient(workerURL, roomID, token string) *Client {
	return &Client{
		workerURL:       workerURL,
		roomID:          roomID,
		token:           token,
		pendingRequests: make(map[string]chan map[string]interface{}),
	}
}

func (c *Client) websocketDialConfig() (string, *websocket.DialOptions, error) {
	parsed, err := url.Parse(c.workerURL)
	if err != nil {
		return "", nil, err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
	default:
		return "", nil, fmt.Errorf("Kavla API URL must use http or https")
	}
	if parsed.Host == "" {
		return "", nil, fmt.Errorf("Kavla API URL has no host")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/data-socket/" + url.PathEscape(c.roomID)
	query := parsed.Query()
	query.Set("clientType", "cli")
	parsed.RawQuery = query.Encode()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.token)
	return parsed.String(), &websocket.DialOptions{HTTPHeader: headers}, nil
}

func (c *Client) Connect(ctx context.Context) error {
	websocketURL, options, err := c.websocketDialConfig()
	if err != nil {
		return err
	}

	dialContext, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(dialContext, websocketURL, options)
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
			message := strings.TrimSpace(string(body))
			if message != "" {
				return fmt.Errorf("Kavla rejected the connection (HTTP %d): %s", response.StatusCode, message)
			}
			return fmt.Errorf("Kavla rejected the connection (HTTP %d)", response.StatusCode)
		}
		return err
	}
	connection.SetReadLimit(32 * 1024 * 1024)

	c.mu.Lock()
	c.connection = connection
	c.context = ctx
	c.mu.Unlock()
	return nil
}

func (c *Client) Read(ctx context.Context) (map[string]interface{}, error) {
	c.mu.Lock()
	connection := c.connection
	c.mu.Unlock()
	if connection == nil {
		return nil, fmt.Errorf("websocket is not connected")
	}

	var message map[string]interface{}
	if err := wsjson.Read(ctx, connection, &message); err != nil {
		return nil, err
	}
	return message, nil
}

func (c *Client) ResolvePending(message map[string]interface{}) bool {
	requestID, ok := message["requestId"].(string)
	if !ok || requestID == "" {
		return false
	}

	c.mu.Lock()
	response, exists := c.pendingRequests[requestID]
	if exists {
		delete(c.pendingRequests, requestID)
	}
	c.mu.Unlock()
	if exists {
		response <- message
	}
	return exists
}

func (c *Client) SendRequest(messageType string, payload interface{}) (map[string]interface{}, error) {
	requestID := uuid.NewString()
	response := make(chan map[string]interface{}, 1)
	c.mu.Lock()
	c.pendingRequests[requestID] = response
	ctx := c.context
	c.mu.Unlock()

	if err := c.SendJSON(map[string]interface{}{
		"type":      messageType,
		"payload":   payload,
		"requestId": requestID,
	}); err != nil {
		c.removePendingRequest(requestID)
		return nil, err
	}

	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case message := <-response:
		if messageError, ok := message["error"].(string); ok && messageError != "" {
			return nil, fmt.Errorf("Kavla request failed: %s", messageError)
		}
		return message, nil
	case <-timer.C:
		c.removePendingRequest(requestID)
		return nil, fmt.Errorf("Kavla request timed out")
	case <-ctx.Done():
		c.removePendingRequest(requestID)
		return nil, ctx.Err()
	}
}

func (c *Client) removePendingRequest(requestID string) {
	c.mu.Lock()
	delete(c.pendingRequests, requestID)
	c.mu.Unlock()
}

func (c *Client) SendJSON(message map[string]interface{}) error {
	c.mu.Lock()
	connection := c.connection
	ctx := c.context
	c.mu.Unlock()
	if connection == nil || ctx == nil {
		return fmt.Errorf("websocket is not connected")
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return wsjson.Write(ctx, connection, message)
}

func (c *Client) SendResultData(shapeID string, format runner.ResultFormat, data []byte, rowCount int64, transient bool) error {
	return c.SendJSON(map[string]interface{}{
		"type":      "relay_data",
		"payload":   base64.StdEncoding.EncodeToString(data),
		"format":    string(format),
		"shapeId":   shapeID,
		"rowCount":  rowCount,
		"transient": transient,
	})
}

func (c *Client) ResolveBlobURL(r2ObjectKey string) (string, error) {
	response, err := c.SendRequest("get_presigned_read_url", map[string]string{
		"r2ObjectKey": r2ObjectKey,
	})
	if err != nil {
		return "", err
	}
	payload, ok := response["payload"].(string)
	if !ok || strings.TrimSpace(payload) == "" {
		return "", fmt.Errorf("Kavla returned no download URL for the canvas file")
	}
	return payload, nil
}

func (c *Client) SendOutput(line string) error {
	return c.SendJSON(map[string]interface{}{
		"type": "cli_output",
		"payload": map[string]interface{}{
			"line":      line,
			"timestamp": time.Now().UnixMilli(),
		},
	})
}

func (c *Client) MaxResultDataBytes() int {
	return maxHostedResultDataSize
}

func (c *Client) Close() error {
	c.mu.Lock()
	connection := c.connection
	c.connection = nil
	c.context = nil
	c.mu.Unlock()
	if connection == nil {
		return nil
	}
	return connection.Close(websocket.StatusNormalClosure, "Kavla CLI disconnected")
}
