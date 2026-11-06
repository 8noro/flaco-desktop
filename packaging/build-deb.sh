#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="flaco-desktop"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(dpkg --print-architecture 2>/dev/null || true)"

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *)
      echo "Arquitectura no soportada: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

for command in ar gzip tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command" >&2
    exit 1
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROOT_DIR="$WORK/root"
mkdir -p \
  "$ROOT_DIR/DEBIAN" \
  "$ROOT_DIR/usr/lib/$PACKAGE/ui" \
  "$ROOT_DIR/usr/bin" \
  "$ROOT_DIR/usr/share/applications" \
  "$ROOT_DIR/usr/share/icons/hicolor/256x256/apps" \
  "$ROOT_DIR/usr/share/doc/$PACKAGE"

cp "$ROOT"/{main.js,config.js,dl-crypto.js,downloads.js,offline-protocol.js,bridge.js,sync.js,presence.js,discord-rpc.js,page-state.js,package.json,icon.png} "$ROOT_DIR/usr/lib/$PACKAGE/"
cp "$ROOT"/ui/* "$ROOT_DIR/usr/lib/$PACKAGE/ui/"
cp "$ROOT/packaging/flaco-desktop.desktop" "$ROOT_DIR/usr/share/applications/$PACKAGE.desktop"
cp "$ROOT/icon.png" "$ROOT_DIR/usr/share/icons/hicolor/256x256/apps/$PACKAGE.png"
cp "$ROOT/LICENSE" "$ROOT_DIR/usr/share/doc/$PACKAGE/LICENSE"

cat > "$ROOT_DIR/usr/bin/$PACKAGE" <<'LAUNCHER'
#!/bin/sh
exec electron --ozone-platform-hint=auto /usr/lib/flaco-desktop "$@"
LAUNCHER
chmod 755 "$ROOT_DIR/usr/bin/$PACKAGE"

cat > "$ROOT_DIR/DEBIAN/control" <<CONTROL
Package: $PACKAGE
Version: $VERSION
Section: sound
Priority: optional
Architecture: $ARCH
Depends: electron
Maintainer: 8noro
Description: Cliente de escritorio de FLACo!
 Cliente Electron con descargas offline y Discord Rich Presence.
CONTROL
chmod 644 "$ROOT_DIR/DEBIAN/control"

mkdir -p "$ROOT/dist"
OUTPUT="$ROOT/dist/${PACKAGE}_${VERSION}_${ARCH}.deb"
(
  cd "$WORK"
  printf '2.0\n' > debian-binary
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf control.tar.gz -C "$ROOT_DIR" DEBIAN
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -czf data.tar.gz -C "$ROOT_DIR" --exclude=DEBIAN .
  ar r "$OUTPUT" debian-binary control.tar.gz data.tar.gz >/dev/null
)

echo "Paquete generado: $OUTPUT"
