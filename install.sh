#!/usr/bin/env bash
# Instalador de FLACo! Desktop para Arch / CachyOS / EndeavourOS
set -euo pipefail
REPO_URL="https://github.com/8noro/flaco-desktop/releases/download/repo"

command -v pacman >/dev/null || { echo "Este instalador es solo para sistemas con pacman (Arch y derivadas)." >&2; exit 1; }

if ! grep -q '^\[oron8\]' /etc/pacman.conf; then
  echo "Agregando el repositorio oron8 a /etc/pacman.conf..."
  printf '\n[oron8]\nSigLevel = Optional TrustAll\nServer = %s\n' "$REPO_URL" | sudo tee -a /etc/pacman.conf >/dev/null
fi

sudo pacman -Syu --needed flaco-desktop
echo "Listo. Ejecutá: flaco-desktop"
