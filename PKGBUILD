# Maintainer: 8noro <tu@mail>
pkgname=flaco-desktop
pkgver=1.2
pkgrel=1
pkgdesc="Cliente de escritorio de FLACo! (Electron) con descargas offline y Discord Rich Presence"
arch=('any')
url="https://github.com/8noro/flaco-desktop"
license=('LicenseRef-OCL-1.1')
depends=('electron')
source=("$pkgname-$pkgver.tar.gz::$url/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('86fa60c7a730de24c478b5a936909d43c573eb1aa134c6263c7edab871175a84')

package() {
  cd "$srcdir/flaco-desktop-$pkgver"
  install -d "$pkgdir/usr/lib/$pkgname" "$pkgdir/usr/bin"
  cp -r main.js config.js dl-crypto.js downloads.js offline-protocol.js \
        bridge.js sync.js presence.js discord-rpc.js page-state.js \
        package.json icon.png ui "$pkgdir/usr/lib/$pkgname/"

  printf '#!/bin/sh\nexec electron --ozone-platform-hint=auto /usr/lib/flaco-desktop "$@"\n' \
    > "$pkgdir/usr/bin/flaco-desktop"
  chmod 755 "$pkgdir/usr/bin/flaco-desktop"

  install -Dm644 packaging/flaco-desktop.desktop \
    "$pkgdir/usr/share/applications/flaco-desktop.desktop"
  install -Dm644 icon.png \
    "$pkgdir/usr/share/icons/hicolor/256x256/apps/flaco-desktop.png"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
