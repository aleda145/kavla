#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

#include "include/cef_app.h"
#include "include/cef_client.h"
#include "include/cef_command_line.h"
#include "include/cef_version.h"
#if defined(OS_MAC)
#include "include/cef_path_util.h"
#endif
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "include/wrapper/cef_helpers.h"

namespace {

int application_exit_code = 0;
std::vector<CefRefPtr<CefBrowser>> open_browsers;

class KavlaWindow : public CefWindowDelegate {
 public:
  explicit KavlaWindow(CefRefPtr<CefBrowserView> view) : view_(view) {}

  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    window->SetTitle("Kavla");
    window->AddChildView(view_);
    window->Show();
    view_->RequestFocus();
  }

  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    view_ = nullptr;
  }

  bool CanClose(CefRefPtr<CefWindow> window) override {
    auto browser = view_->GetBrowser();
    return !browser || browser->GetHost()->TryCloseBrowser();
  }

  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    return CefSize(1440, 900);
  }

  CefSize GetMinimumSize(CefRefPtr<CefView> view) override {
    return CefSize(900, 600);
  }

  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_ALLOY;
  }

 private:
  CefRefPtr<CefBrowserView> view_;
  IMPLEMENT_REFCOUNTING(KavlaWindow);
};

class KavlaBrowserView : public CefBrowserViewDelegate {
 public:
  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return CEF_RUNTIME_STYLE_ALLOY;
  }

  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                CefRefPtr<CefBrowserView> popup,
                                bool is_devtools) override {
    CefWindow::CreateTopLevelWindow(new KavlaWindow(popup));
    return true;
  }

 private:
  IMPLEMENT_REFCOUNTING(KavlaBrowserView);
};

class KavlaClient : public CefClient,
                    public CefLifeSpanHandler,
                    public CefDisplayHandler,
                    public CefLoadHandler,
                    public CefRequestHandler,
                    public CefDownloadHandler,
                    public CefKeyboardHandler {
 public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    ++browsers_;
    open_browsers.push_back(browser);
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    CEF_REQUIRE_UI_THREAD();
    std::erase_if(open_browsers, [&](const auto& item) { return item->IsSame(browser); });
    if (--browsers_ == 0) {
      CefQuitMessageLoop();
    }
  }

  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override {
    auto view = CefBrowserView::GetForBrowser(browser);
    if (view && view->GetWindow()) {
      view->GetWindow()->SetTitle(title);
    }
  }

  void OnLoadEnd(CefRefPtr<CefBrowser> browser,
                 CefRefPtr<CefFrame> frame,
                 int http_status_code) override {
    if (frame->IsMain()) {
      std::cout << "CEF loaded " << frame->GetURL().ToString()
                << " (HTTP " << http_status_code << ")" << std::endl;
    }
  }

  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode error_code,
                   const CefString& error_text,
                   const CefString& failed_url) override {
    if (frame->IsMain() && error_code != ERR_ABORTED) {
      std::cerr << "CEF failed to load " << failed_url.ToString()
                << ": " << error_text.ToString() << std::endl;
      application_exit_code = 1;
      browser->GetHost()->CloseBrowser(true);
    }
  }

  void OnRenderProcessTerminated(CefRefPtr<CefBrowser> browser,
                                 TerminationStatus status,
                                 int error_code,
                                 const CefString& error_string) override {
    std::cerr << "CEF renderer exited: " << error_code << " "
              << error_string.ToString() << std::endl;
    application_exit_code = 1;
    browser->GetHost()->CloseBrowser(true);
  }

  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefDownloadItem> item,
                        const CefString& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback) override {
    callback->Continue(CefString(), true);
    return true;
  }

  bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                     const CefKeyEvent& event,
                     CefEventHandle os_event,
                     bool* is_keyboard_shortcut) override {
    // F12 opens Chromium DevTools for comparing frame timing and rendering.
    if (event.type == KEYEVENT_RAWKEYDOWN && event.windows_key_code == 0x7B) {
      CefWindowInfo info;
      CefBrowserSettings settings;
      browser->GetHost()->ShowDevTools(info, this, settings, CefPoint());
      return true;
    }
    return false;
  }

 private:
  int browsers_ = 0;
  IMPLEMENT_REFCOUNTING(KavlaClient);
};

class KavlaApp : public CefApp, public CefBrowserProcessHandler {
 public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnBeforeCommandLineProcessing(const CefString& process_type,
                                     CefRefPtr<CefCommandLine> command_line) override {
    if (process_type.empty()) {
#if defined(OS_LINUX)
      // AppImages cannot install a root-owned setuid helper. Keep Chromium's
      // user-namespace sandbox enabled instead.
      command_line->AppendSwitch("disable-setuid-sandbox");
      if (const char* platform = std::getenv("KAVLA_CEF_OZONE_PLATFORM")) {
        command_line->AppendSwitchWithValue("ozone-platform", platform);
      }
#endif
    }
  }

  void OnContextInitialized() override {
    CEF_REQUIRE_UI_THREAD();
    auto command_line = CefCommandLine::GetGlobalCommandLine();
    CefBrowserSettings settings;
    auto view = CefBrowserView::CreateBrowserView(
        new KavlaClient(), command_line->GetSwitchValue("url"), settings,
        nullptr, nullptr, new KavlaBrowserView());
    CefWindow::CreateTopLevelWindow(new KavlaWindow(view));
  }

 private:
  IMPLEMENT_REFCOUNTING(KavlaApp);
};

}  // namespace

void CloseKavlaBrowsers() {
  CEF_REQUIRE_UI_THREAD();
  const auto browsers = open_browsers;
  for (const auto& browser : browsers) {
    browser->GetHost()->CloseBrowser(false);
  }
}

NO_STACK_PROTECTOR
int RunKavla(int argc, char* argv[]) {
  CefMainArgs main_args(argc, argv);
  CefRefPtr<KavlaApp> app(new KavlaApp());
#if !defined(OS_MAC)
  int exit_code = CefExecuteProcess(main_args, app, nullptr);
  if (exit_code >= 0) {
    return exit_code;
  }
#endif

  auto command_line = CefCommandLine::CreateCommandLine();
  command_line->InitFromArgv(argc, argv);
  if (!command_line->HasSwitch("url") || !command_line->HasSwitch("cache-path")) {
    std::cerr << "Launch the Kavla desktop package, or supply --url and --cache-path." << std::endl;
    return 1;
  }

  CefSettings settings;
#if defined(OS_MAC)
  CefString executable_dir;
  if (!CefGetPath(PK_DIR_EXE, executable_dir)) {
    std::cerr << "Could not locate the Kavla app bundle." << std::endl;
    return 1;
  }
  CefString(&settings.browser_subprocess_path) = executable_dir.ToString() +
      "/../Frameworks/Kavla Helper.app/Contents/MacOS/Kavla Helper";
  CefString(&settings.main_bundle_path) = executable_dir.ToString() + "/../..";
#endif
  CefString(&settings.root_cache_path) = command_line->GetSwitchValue("cache-path");
  CefString(&settings.cache_path) = command_line->GetSwitchValue("cache-path");
  CefString(&settings.log_file) = command_line->GetSwitchValue("log-file");
  settings.background_color = CefColorSetARGB(255, 248, 250, 252);
  std::cout << "Kavla CEF " << CEF_VERSION << " / Chromium "
            << CHROME_VERSION_MAJOR << "." << CHROME_VERSION_MINOR << "."
            << CHROME_VERSION_BUILD << "." << CHROME_VERSION_PATCH << std::endl;
  if (!CefInitialize(main_args, settings, app, nullptr)) {
    return CefGetExitCode();
  }
  CefRunMessageLoop();
  CefShutdown();
  return application_exit_code;
}

#if !defined(OS_MAC)
NO_STACK_PROTECTOR
int main(int argc, char* argv[]) {
  return RunKavla(argc, argv);
}
#endif
