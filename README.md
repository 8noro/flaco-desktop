<div align="center">
  <img src="icon.png" alt="FLACo! Desktop logo" width="160">
  <h1>FLACo! Desktop</h1>
  <p>A desktop music player for FLACo!, with offline listening, system media controls, and Discord Rich Presence.</p>
  <p>
    <a href="https://github.com/8noro/flaco-desktop/releases"><img src="https://img.shields.io/badge/Linux-available-8b5cf6?style=for-the-badge" alt="Linux available"></a>
    <a href="https://github.com/8noro/flaco-desktop/releases"><img src="https://img.shields.io/badge/Windows-available-0078D4?style=for-the-badge" alt="Windows available"></a>
    <img src="https://img.shields.io/badge/macOS-coming%20soon-555?style=for-the-badge" alt="macOS coming soon">
    <img src="https://img.shields.io/badge/Electron-desktop-47848f?style=for-the-badge" alt="Built with Electron">
  </p>
</div>

The app opens the FLACo! web player in its own desktop window and adds desktop integrations. The player interface loads from the configured server, so you need a FLACo! account to sign in. Previously downloaded music can be played offline.

> **Windows:** Download the Windows version from the [Releases page](https://github.com/8noro/flaco-desktop/releases). **macOS support is coming soon.**

FLACo! Desktop is based on the original work by [Oron_8 (@Oron8)](https://github.com/Oron8).

## Features

- **Desktop player:** standalone window, system tray, and system media controls (MPRIS).
- **Offline mode:** download music from the web player and listen through a built-in local interface when you're offline.
- **Download manager:** queue, pause, retries, configurable concurrency and audio quality. Keep albums, playlists, artists, and liked tracks downloaded.
- **Discord Rich Presence:** show what you're listening to, with automatic detection to avoid conflicts with `flaco-presence`.
- **Client settings:** customize the server URL, presence, download quality, and window behavior.

## Requirements

- **Linux _(recommended)_** or Windows
- Node.js and npm to run from source or install without system-wide Electron.
- A FLACo! account to sign in and download music. (Optional)
- The Discord desktop app. (if you want to use Rich Presence)

## Installation

### Arch Linux, CachyOS, and EndeavourOS

#### Recommended: one-command install

```bash
curl -fsSL oron8.com/flaco | bash
```

This installer adds the `oron8` repository to `/etc/pacman.conf` if it is not already configured, then updates package databases and installs FLACo! Desktop. It is only for systems with `pacman`.

#### Manual repository setup

Add the repository to the end of `/etc/pacman.conf`:

```ini
[oron8]
SigLevel = Optional TrustAll
Server = https://github.com/8noro/flaco-desktop/releases/download/repo
```

Then install FLACo! Desktop:

```bash
sudo pacman -Syu flaco-desktop
```

To uninstall:

```bash
sudo pacman -Rns flaco-desktop
```

> **Warning:** uninstalling removes the app, but settings and offline downloads may remain in your user data directory.

### Debian, Ubuntu, and derivatives

A `.deb` package depends on the `electron` package from your distribution. To build and install it from a checkout:

```bash
sudo apt update
sudo apt install git nodejs binutils tar gzip
git clone https://github.com/8noro/flaco-desktop.git
cd flaco-desktop
./packaging/build-deb.sh
sudo apt install ./dist/flaco-desktop_*.deb
```

The build script creates a package for the current architecture under `dist/`. `apt` installs Electron as a package dependency. Once installed, launch **FLACo!** from the applications menu or run `flaco-desktop`. Remove it with `sudo apt remove flaco-desktop`.

The `.deb` can also be attached to a GitHub Release for direct downloads. For installation and updates through `apt` without downloading each release manually, the package must additionally be published in a signed APT repository.

## Windows (secondary platform)

Linux is FLACo! Desktop's target platform. Windows builds are provided as a best-effort option and may have platform-specific issues or receive less testing.

Just run the .exe installer provided in the releases page (or [here](https://release-assets.githubusercontent.com/github-production-release-asset/1420004155/205cb7ab-e6eb-4b97-b3de-834740ed3b00?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-11-02T22%3A02%3A22Z&rscd=attachment%3B+filename%3DFLACo-1.2.0-win-x64-setup.exe&rsct=application%2Foctet-stream&skoid=96c2d410-5711-43a1-aedd-ab1947aa7ab0&sktid=398a6654-997b-47e9-b12b-9515b896b4de&skt=2026-11-02T21%3A02%3A08Z&ske=2026-11-02T22%3A02%3A22Z&sks=b&skv=2018-11-09&sig=dWzPuw%2F0zSHRA%2FaE3mMF154Sx6l%2BwuOURF4%2BTv9R3i8%3D&jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmVsZWFzZS1hc3NldHMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwia2V5Ijoia2V5MSIsImV4cCI6MTc5MzY1NzI0NywibmJmIjoxNzkzNjUzNjQ3LCJwYXRoIjoicmVsZWFzZWFzc2V0cHJvZHVjdGlvbi5ibG9iLmNvcmUud2luZG93cy5uZXQifQ.hb0fZ8-dR1PNdfl7HBg7spYDXH8sUFGf-Gi9C5htoPE&response-content-disposition=attachment%3B%20filename%3DFLACo-1.2.0-win-x64-setup.exe&response-content-type=application%2Foctet-stream))
## Run from source

```bash
npm install
npm start
```

By default, the app opens `https://music.oron8.com`. You can change the server URL in the client settings.

## Usage

- **Open client settings:** `Ctrl+,`
- **Open offline player:** `Ctrl+Shift+O`
- **Quit:** `Ctrl+Q` or choose **Quit** from the system tray

To download music, sign in and use the download button in the web player. Manage downloads under **Client settings → Offline downloads**. If you set an expiration period, expired files are not deleted; they become unavailable until FLACo! reconnects.

For **Discord Rich Presence**, choose automatic, always on, or off in the client settings. To configure it manually, create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and enter its Application ID. No API key is needed.

## Data and privacy

Settings and downloads are stored in Electron's application data directory. Downloaded content and its index are encrypted. Offline playback depends on the local key remaining available to the same user and system. The app uses your signed-in web session to request downloads and sync pending playback activity.

## Project structure

| File or directory | Purpose |
| --- | --- |
| `main.js` | Electron window, tray, system controls, and app lifecycle |
| `config.js` | Defaults and settings persistence |
| `downloads.js`, `dl-crypto.js` | Download queue, encrypted storage, and key management |
| `offline-protocol.js`, `ui/offline.*` | Local protocol and offline player |
| `bridge.js`, `sync.js`, `page-state.js` | Web player integration and synchronization |
| `presence.js`, `discord-rpc.js` | Discord Rich Presence |
| `ui/` | Settings screens and interface assets |
| `packaging/`, `install.sh` | Linux launcher, desktop entry, and installer |

## License

This project is licensed under the [8noro Community License (OCL) v1.1](./LICENSE). See the license for permissions, restrictions, and attribution requirements.

## Thanks

Thanks for checking out and supporting FLACo! and FLACo Desktop!

With <3, 8_noro!
