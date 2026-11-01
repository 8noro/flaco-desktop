# FLACo! Desktop

Cliente de escritorio de FLACo! (Linux): la interfaz web dentro de una ventana propia (Electron), con:

- Bandeja del sistema y teclas multimedia
- Descargas sin conexión cifradas (gestor con cola, reproductor y pantalla offline)
- Discord Rich Presence integrada (se desactiva si ya corre el servicio `flaco-presence`)

## Ejecutar desde el código

```bash
npm install
npm start
```

Ajustes dentro de la app: `Ctrl+,`

## Estructura

| Archivo | Función |
|---|---|
| `main.js` | Proceso principal, ventana, bandeja |
| `config.js` | Configuración |
| `downloads.js`, `dl-crypto.js` | Gestor de descargas y cifrado |
| `offline-protocol.js` | Protocolo `flaco-dl://` |
| `bridge.js`, `sync.js` | Puente con la web y sincronización de reproducciones |
| `presence.js`, `discord-rpc.js` | Discord Rich Presence |
| `ui/` | Pantallas de ajustes y sin conexión |
| `packaging/` | Lanzador y `.desktop` |
