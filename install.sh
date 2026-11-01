#!/usr/bin/env bash
# Instalador de FLACo! Desktop para Arch / CachyOS / EndeavourOS
# No actualiza el sistema: solo sincroniza el repo "oron8" y pregunta antes de instalar.
set -euo pipefail
REPO_URL="https://github.com/8noro/flaco-desktop/releases/download/repo"

command -v pacman >/dev/null || { echo "Este instalador es solo para sistemas con pacman (Arch y derivadas)." >&2; exit 1; }
[ -r /dev/tty ] || { echo "Hace falta una terminal interactiva para confirmar la instalación." >&2; exit 1; }

if ! grep -q '^\[oron8\]' /etc/pacman.conf; then
  echo "Agregando el repositorio oron8 a /etc/pacman.conf..."
  printf '\n[oron8]\nSigLevel = Optional TrustAll\nServer = %s\n' "$REPO_URL" | sudo tee -a /etc/pacman.conf >/dev/null
fi

# Sincroniza solo la base de datos de oron8 (sin tocar las demás: evita una actualización parcial)
echo "Sincronizando el repositorio oron8..."
sudo install -d /var/lib/pacman/sync
sudo curl -fsSL -o /var/lib/pacman/sync/oron8.db "$REPO_URL/oron8.db"

# </dev/tty: permite que pacman te pregunte [S/n] aunque el script venga por "curl | bash"
sudo pacman -S --needed flaco-desktop </dev/tty
echo "Listo. Ejecutá: flaco-desktop"
