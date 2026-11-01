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

FLACo! Desktop is based on the original work by [8norO (@8noro)](https://github.com/8noro), including the [original repository](https://github.com/8noro/flaco-desktop).

## Features

- **Desktop player:** standalone window, system tray, and system media controls (MPRIS).
- **Offline mode:** download music from the web player and listen through a built-in local interface when you're offline.
- **Download manager:** queue, pause, retries, configurable concurrency and audio quality. Keep albums, playlists, artists, and liked tracks downloaded.
- **Encrypted storage:** downloads are encrypted with AES-256. The encryption key is protected by the system keychain when available.
- **Discord Rich Presence:** show what you're listening to, with automatic detection to avoid conflicts with `flaco-presence`.
- **Client settings:** customize the server URL, presence, download quality, and window behavior.

## Requirements

- Linux.
- Node.js and npm to run from source or install without system-wide Electron.
- A FLACo! account to sign in and download music.
- The Discord desktop app, if you want to use Rich Presence.

## Installation

### Arch Linux, CachyOS, and EndeavourOS

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

### Manual installation

Clone or download this repository, then run the installer from its directory:

```bash
bash install.sh
```

The installer sets up FLACo! Desktop under `~/.local`, adds an application-menu shortcut, and installs the `flaco-desktop` command in `~/.local/bin`. If Electron is not installed system-wide, it installs a local copy for the app.

To uninstall:

```bash
bash install.sh --quitar
```

> **Warning:** uninstalling also deletes FLACo! Desktop's settings and offline downloads.

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
