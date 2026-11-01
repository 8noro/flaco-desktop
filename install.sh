#!/usr/bin/env bash
# Instala FLACo! Desktop desde este repo en ~/.local. Uso: bash install.sh [--quitar]
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.local/share/flaco-desktop"; APP="$DIR/app"
BIN="$HOME/.local/bin/flaco-desktop"
DESK="$HOME/.local/share/applications/flaco-desktop.desktop"
ICO="$HOME/.local/share/icons/hicolor/256x256/apps/flaco-desktop.png"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/flaco-desktop"
if [ "${1:-}" = "--quitar" ]; then
  pkill -f "$APP" 2>/dev/null || true
  rm -rf "$DIR" "$CFG"; rm -f "$BIN" "$DESK" "$ICO"; echo "Desinstalado."; exit 0
fi
command -v electron >/dev/null || command -v npm >/dev/null || { echo "Falta Electron o npm" >&2; exit 1; }
mkdir -p "$APP" "$(dirname "$BIN")" "$(dirname "$DESK")" "$(dirname "$ICO")"
cp -r "$SRC"/{main,config,dl-crypto,downloads,offline-protocol,bridge,sync,presence,discord-rpc,page-state}.js "$SRC"/package.json "$SRC"/icon.png "$SRC"/ui "$APP"/
cp "$SRC/icon.png" "$ICO"
if ! command -v electron >/dev/null; then (cd "$APP" && npm install --no-audit --no-fund); fi
install -m755 "$SRC/packaging/flaco-desktop" "$BIN"
cp "$SRC/packaging/flaco-desktop.desktop" "$DESK"
update-desktop-database "$(dirname "$DESK")" 2>/dev/null || true
echo "Listo. Ejecutá: flaco-desktop"
