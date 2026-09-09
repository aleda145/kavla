#import <Cocoa/Cocoa.h>

#include "include/cef_application_mac.h"
#include "include/wrapper/cef_helpers.h"
#include "include/wrapper/cef_library_loader.h"

int RunKavla(int argc, char* argv[]);
void CloseKavlaBrowsers();

@interface KavlaApplication : NSApplication <CefAppProtocol> {
  BOOL handlingSendEvent_;
}
@end

@implementation KavlaApplication
- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}
- (void)setHandlingSendEvent:(BOOL)value {
  handlingSendEvent_ = value;
}
- (void)sendEvent:(NSEvent*)event {
  CefScopedSendingEvent sendingEvent;
  [super sendEvent:event];
}
- (void)terminate:(id)sender {
  // Leave CEF's loop normally so the Go parent can finish saving the document.
  CloseKavlaBrowsers();
}
@end

@interface KavlaApplicationDelegate : NSObject <NSApplicationDelegate>
@end

@implementation KavlaApplicationDelegate
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication*)app {
  return YES;
}
@end

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader libraryLoader;
  if (!libraryLoader.LoadInMain()) {
    return 1;
  }
  @autoreleasepool {
    [KavlaApplication sharedApplication];
    CHECK([NSApp isKindOfClass:[KavlaApplication class]]);
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    KavlaApplicationDelegate* delegate = [[KavlaApplicationDelegate alloc] init];
    [NSApp setDelegate:delegate];

    NSMenu* menu = [[NSMenu alloc] init];
    NSMenuItem* appItem = [[NSMenuItem alloc] init];
    [menu addItem:appItem];
    NSMenu* appMenu = [[NSMenu alloc] initWithTitle:@"Kavla"];
    [appMenu addItemWithTitle:@"Quit Kavla" action:@selector(terminate:) keyEquivalent:@"q"];
    [appItem setSubmenu:appMenu];
    NSMenuItem* editItem = [[NSMenuItem alloc] init];
    [menu addItem:editItem];
    NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editItem setSubmenu:editMenu];
    [NSApp setMainMenu:menu];
    int result = RunKavla(argc, argv);
    [NSApp setDelegate:nil];
    return result;
  }
}
