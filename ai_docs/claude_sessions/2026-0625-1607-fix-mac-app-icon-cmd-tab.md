# Fix: macOS app icon missing in Cmd+Tab switcher

**Date:** 2026-06-25 16:07 &nbsp;|&nbsp; **Session ID:** 26ca1f8a-411a-46c2-a5bf-ca5535f40979

## Problem

The new KRo app icon shows correctly in Spotlight and Finder, but the **Cmd+Tab
application switcher** (and Dock) still display the generic placeholder icon.

## Root cause

- The `.app` bundle's `KRo.icns` and `CFBundleIconFile` are correct — that's why
  Spotlight/Finder show the new icon (they read the icns directly via Icon Services).
- The Cmd+Tab switcher and Dock render the **running app's** `applicationIconImage`,
  which macOS caches by bundle id (`dev.kro.KRo`).
- The Swift wrapper in `mac-install.sh` never set a runtime icon, so the switcher
  kept serving the stale/generic cached icon even though the on-disk bundle was fresh
  (the installer `rm -rf`s and recreates the bundle at the same path / bundle id).

## Fix

In `mac-install.sh` (the embedded Swift `AppDelegate`):

1. Added an `applyAppIcon()` call right after `NSApp.setActivationPolicy(.regular)`
   in `applicationDidFinishLaunching`.
2. Added the `applyAppIcon()` method, which loads the bundled `KRo.icns` and assigns
   it to `NSApp.applicationIconImage`, bypassing the runtime icon cache:

```swift
private func applyAppIcon() {
    guard let iconURL = Bundle.main.url(forResource: "KRo", withExtension: "icns"),
          let icon = NSImage(contentsOf: iconURL) else { return }
    NSApp.applicationIconImage = icon
}
```

Note: the Swift source is emitted from an **unquoted** `<<EOF` heredoc, so the added
code was kept free of `$` and backticks to avoid shell interpolation.

## To pick it up

```sh
./mac-install.sh        # rebuilds the Swift wrapper with the fix
```

Then Cmd+Q the running `KRo.app` and relaunch — the Cmd+Tab icon will be correct.

## Follow-ups (not done)

- Optional belt-and-suspenders: add a one-time LaunchServices/Dock cache refresh
  (`killall Dock`, `lsregister -f`) to the installer. Not needed now that the icon is
  set at runtime.

## Files changed

- `mac-install.sh` — added runtime icon assignment in the Swift `AppDelegate`.
