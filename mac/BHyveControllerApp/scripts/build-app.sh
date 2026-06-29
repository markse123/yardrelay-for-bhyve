#!/usr/bin/env bash
set -euo pipefail

APP_NAME="YardRelay"
EXECUTABLE_NAME="BHyveControllerApp"
BUILD_CONFIG="${1:-release}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_ROOT="$(cd "$PROJECT_DIR/../.." && pwd)"
NODE_PATH="$(command -v node || true)"
APP_VERSION="$(node -p "require('$SERVER_ROOT/package.json').version")"

swift build --package-path "$PROJECT_DIR" -c "$BUILD_CONFIG"
BIN_DIR="$(swift build --package-path "$PROJECT_DIR" -c "$BUILD_CONFIG" --show-bin-path)"

APP_DIR="$PROJECT_DIR/.build/app/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICONSET_DIR="$PROJECT_DIR/.build/icon/AppIcon.iconset"

mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp "$BIN_DIR/$EXECUTABLE_NAME" "$MACOS_DIR/$EXECUTABLE_NAME"
rm -rf "$RESOURCES_DIR/Help"
mkdir -p "$RESOURCES_DIR/Help"
cp -R "$SERVER_ROOT/public/help/." "$RESOURCES_DIR/Help/"
node "$SCRIPT_DIR/generate-icon.mjs" "$ICONSET_DIR"
iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$EXECUTABLE_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.markse123.yardrelay</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>BHyveControllerRoot</key>
  <string>$SERVER_ROOT</string>
  <key>BHyveNodePath</key>
  <string>$NODE_PATH</string>
</dict>
</plist>
PLIST

echo "Built $APP_DIR"
