//go:build production || dev

package cmd

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/aleda145/kavla/cli/internal/localapp"
	"github.com/aleda145/kavla/cli/internal/webapp"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const desktopShutdownTimeout = 30 * time.Second

func desktopWindowTitle(canvasName string) string {
	canvasName = strings.TrimSpace(canvasName)
	if strings.HasSuffix(strings.ToLower(canvasName), ".kavla") {
		canvasName = canvasName[:len(canvasName)-len(".kavla")]
	}
	if canvasName == "" {
		canvasName = "Untitled"
	}
	return "Kavla - " + canvasName
}

func runDesktop(
	server *localapp.Server,
	launchURL, canvasName string,
	onDocumentChanged func(documentName, documentPath string),
) error {
	icon, err := webapp.Icon()
	if err != nil {
		return err
	}

	var closeOnce sync.Once
	var closeErr error
	var runtimeMu sync.RWMutex
	var runtimeContext context.Context
	setWindowTitle := func(documentName string) {
		runtimeMu.RLock()
		ctx := runtimeContext
		runtimeMu.RUnlock()
		if ctx != nil {
			wailsruntime.WindowSetTitle(ctx, desktopWindowTitle(documentName))
		}
	}
	handleDocumentChanged := func(documentName, documentPath string) {
		setWindowTitle(documentName)
		onDocumentChanged(documentName, documentPath)
	}
	server.SetDocumentChangeHandler(handleDocumentChanged)
	defer server.SetDocumentChangeHandler(nil)

	closeServer := func() {
		closeOnce.Do(func() {
			fmt.Println("Saving Kavla document...")
			ctx, cancel := context.WithTimeout(context.Background(), desktopShutdownTimeout)
			defer cancel()
			if err := server.Close(ctx); err != nil {
				closeErr = fmt.Errorf("close Kavla document: %w", err)
				log.Printf("Could not close Kavla cleanly: %v", err)
				return
			}
			fmt.Println("Saved.")
		})
	}

	err = wails.Run(&options.App{
		Title:            desktopWindowTitle(canvasName),
		Width:            1440,
		Height:           900,
		MinWidth:         900,
		MinHeight:        600,
		BackgroundColour: &options.RGBA{R: 248, G: 250, B: 252, A: 255},
		AssetServer: &assetserver.Options{
			Handler: desktopLandingHandler(launchURL),
		},
		EnableDefaultContextMenu: true,
		OnStartup: func(ctx context.Context) {
			runtimeMu.Lock()
			runtimeContext = ctx
			runtimeMu.Unlock()
			setWindowTitle(canvasName)
		},
		OnShutdown: func(context.Context) { closeServer() },
		Linux: &linux.Options{
			ProgramName: "Kavla",
			Icon:        icon,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: false,
				HideTitle:                  false,
				HideTitleBar:               false,
				FullSizeContent:            false,
			},
			Appearance: mac.DefaultAppearance,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			ZoomFactor:           1,
		},
	})
	closeServer()
	if err != nil {
		return fmt.Errorf("open Kavla desktop window (build with `make build-app` or `wails build`): %w", err)
	}
	return closeErr
}
