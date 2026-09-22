#!/usr/bin/env bash
# Build PurrgeBar.app with purrge compiled into it, so the app runs without Bun.
#
#   apps/menubar/scripts/bundle.sh           → apps/menubar/build/PurrgeBar.app
#   apps/menubar/scripts/bundle.sh --install → also copies it to ~/Applications
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$APP_DIR/../.." && pwd)"
OUT="$APP_DIR/build"
APP="$OUT/PurrgeBar.app"
VERSION="$(bun -e 'console.log(require(process.argv[1]).version)' "$REPO/package.json")"

echo "→ compiling purrge v$VERSION"
mkdir -p "$OUT"
bun build "$REPO/src/index.ts" --compile --outfile "$OUT/purrge" >/dev/null

echo "→ building PurrgeBar"
swift build -c release --package-path "$APP_DIR" >/dev/null
BIN="$(swift build -c release --package-path "$APP_DIR" --show-bin-path)/PurrgeBar"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/PurrgeBar"
cp "$OUT/purrge" "$APP/Contents/Resources/purrge"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PurrgeBar</string>
  <key>CFBundleDisplayName</key><string>purrge</string>
  <key>CFBundleIdentifier</key><string>com.jvanhouts.purrge.bar</string>
  <key>CFBundleExecutable</key><string>PurrgeBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# Ad-hoc signed: enough to run locally, not to hand to someone else.
codesign --force --sign - "$APP/Contents/Resources/purrge"
codesign --force --sign - "$APP"

echo "✓ $APP"

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/PurrgeBar.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "✓ installed to ~/Applications/PurrgeBar.app"
fi
