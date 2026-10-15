'use strict';
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, session, safeStorage } = require('electron');
const { Config } = require('./config');
const { PresenceManager } = require('./presence');
const { DownloadManager } = require('./downloads');
const { KeyVault } = require('./dl-crypto');

const ICON = path.join(__dirname, 'icon.png');
const UI = (f) => path.join(__dirname, 'ui', f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Audio sin gestos previos, teclas multimedia (MPRIS en Linux) y Wayland nativo.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
if (process.platform === 'linux') app.setDesktopName('flaco-desktop.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

let cfg, win = null, tray = null, settingsWin = null, presence = null, dl = null, dlVault = null;
let pageState = null, quitting = false, cleaned = false, boundsT = null;

// ---- lo que suena: se lee del estado de la propia pagina (const S, A(), toggle/next/prev de la UI web) ----
const { READ_JS } = require('./page-state');

function sameOrigin(u) {
  try { return new URL(u).origin === new URL(cfg.get().url).origin; } catch { return false; }
}

async function readPageState() {
  if (!win || win.isDestroyed()) return null;
  const wc = win.webContents;
  if (wc.isLoading() || !sameOrigin(wc.getURL())) return null;
  try {
    const r = await Promise.race([wc.executeJavaScript(READ_JS, false), sleep(1500).then(() => null)]);
    return r ? Object.assign(r, { at: Date.now() }) : null;
  } catch { return null; }
}

function control(fn) {
  if (!['toggle', 'next', 'prev'].includes(fn) || !win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`typeof ${fn}==='function'&&${fn}()`, false).catch(() => {});
}

// ---- ventana principal: la misma UI de la web ----
function createWindow() {
  const c = cfg.get();
  const b = c.bounds || {};
  const opts = {
    width: b.width || 1280, height: b.height || 800, minWidth: 420, minHeight: 500,
    show: false, title: 'FLACo!', icon: ICON, backgroundColor: '#101014', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false },
  };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) { opts.x = b.x; opts.y = b.y; }
  win = new BrowserWindow(opts);
  win.once('ready-to-show', () => {
    if (c.maximized) win.maximize();
    if (!c.startMinimized) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && cfg.get().closeToTray && tray) { e.preventDefault(); win.hide(); rebuildTray(); }
  });
  win.on('closed', () => { win = null; });
  const saveBounds = () => {
    clearTimeout(boundsT);
    boundsT = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
      const max = win.isMaximized();
      cfg.set(max ? { maximized: true } : { maximized: false, bounds: win.getBounds() });
    }, 600);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);
  win.on('show', rebuildTray);
  win.on('hide', rebuildTray);

  const wc = win.webContents;
  wc.on('did-fail-load', (_e, code, desc, _url, isMain) => {
    if (!isMain || code === -3) return; // -3 = carga cancelada (navegación normal)
    win.loadFile(UI('offline.html'), { query: { u: cfg.get().url, e: desc || '' } });
  });
  win.loadURL(c.url);
}

function showWin() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
function toggleWin() { if (win && win.isVisible() && win.isFocused()) win.hide(); else showWin(); }

// Reglas para TODAS las ventanas web: nada de navegar fuera del servidor ni abrir enlaces externos dentro de la app.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'window') return;
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, autoHideMenuBar: true, icon: ICON } };
    }
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url === 'flaco-ajustes:' || url.startsWith('flaco-ajustes:')) { e.preventDefault(); openSettings(); return; }
    if (sameOrigin(url)) return;
    if (wc.getURL().startsWith('file:') && /^https?:/i.test(url)) return;
    e.preventDefault();
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
  });
  wc.on('context-menu', (_ev, p) => {
    if (!p.isEditable) return;
    Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' }]).popup();
  });
});

// ---- bandeja ----
let trayKey = '';
function rebuildTray() {
  if (!tray) return;
  const s = pageState;
  const np = s && s.id ? `${s.playing ? '▶' : '⏸'} ${s.title} — ${s.artist}` : 'Nada sonando';
  const vis = !!(win && win.isVisible());
  const st = presence ? presence.getStatus() : { text: '' };
  const ds = dlSummary();
  const dlText = !ds ? '' : ds.fatal ? 'Descargas: problema con el almacenamiento'
    : ds.counts.queued || ds.counts.errors ? `Descargas: ${ds.counts.queued} en cola${ds.counts.errors ? ` · ${ds.counts.errors} con error` : ''}${ds.paused ? ' (en pausa)' : ''}` : '';
  const key = [np, vis, st.text, dlText].join('|');
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(s && s.id ? `FLACo! · ${s.title} — ${s.artist}` : 'FLACo!');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: np.slice(0, 80), enabled: false },
    { label: s && s.playing ? 'Pausar' : 'Reproducir', click: () => control('toggle') },
    { label: 'Anterior', click: () => control('prev') },
    { label: 'Siguiente', click: () => control('next') },
    { type: 'separator' },
    { label: vis ? 'Ocultar ventana' : 'Mostrar FLACo!', click: toggleWin },
    { label: 'Ajustes del cliente…', click: openSettings },
    { label: 'Discord: ' + st.text, enabled: false },
    ...(dlText ? [{ type: 'separator' }, { label: dlText, enabled: false },
      { label: ds.paused ? 'Reanudar descargas' : 'Pausar descargas', enabled: !ds.fatal, click: () => { if (dl) { if (ds.paused) dl.resumeAll(); else dl.pauseAll(); } } }] : []),
    { type: 'separator' },
    { label: 'Salir', click: quit },
  ]));
}

function buildTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
    tray.on('click', toggleWin);
    rebuildTray();
  } catch (e) { tray = null; console.error('Sin bandeja:', e.message); }
}

// ---- ajustes del cliente ----
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 700, title: 'Ajustes del cliente · FLACo!', icon: ICON, autoHideMenuBar: true,
    parent: win && !win.isDestroyed() && win.isVisible() ? win : undefined, backgroundColor: '#101014',
    webPreferences: { preload: UI('settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(UI('settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

const fromSettings = (e) => !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
// Resumen liviano de las descargas (la lista completa de descargados puede ser enorme).
function dlSummary() {
  if (!dl) return null;
  const s = dl.getState();
  return { ready: s.ready, fatal: s.fatal, paused: s.paused, authBlocked: s.authBlocked, storage: s.storage, bytes: s.bytes,
    counts: s.counts, jobs: s.jobs.slice(0, 60) };
}
const snapshot = () => ({ cfg: cfg.get(), presence: presence.getStatus(), version: app.getVersion(), dl: dlSummary() });

// ---- descargas offline (tanda 1: gestor + almacenamiento cifrado) ----
// Una carpeta por servidor (si cambias la URL, las descargas del otro servidor quedan aparte) y una sola clave maestra.
const dlOrigin = () => { try { return new URL(cfg.get().url).origin; } catch { return ''; } };
async function makeDownloads() {
  if (dl) { const old = dl; dl = null; await old.shutdown().catch(() => {}); }
  const root = path.join(app.getPath('userData'), 'downloads');
  if (!dlVault) dlVault = new KeyVault({ dir: root, safeStorage, log: (...a) => console.log('llavero:', ...a) });
  const sub = crypto.createHash('sha1').update(dlOrigin()).digest('hex').slice(0, 12);
  const ses = session.defaultSession;
  dl = new DownloadManager({
    dir: path.join(root, sub), vault: dlVault,
    // La sesión de la ventana: ya trae las cookies de tu cuenta, no hace falta API key.
    fetch: (u, o) => (typeof ses.fetch === 'function' ? ses.fetch(u, { ...o, credentials: 'include' }) : require('electron').net.fetch(u, { ...o, credentials: 'include' })),
    getBase: () => cfg.get().url,
    getQuality: () => cfg.get().dlQuality,
    getConcurrency: () => cfg.get().dlConcurrency,
    log: (...a) => console.log('descargas:', ...a),
  });
  dl.on('state', () => rebuildTray());
  dl.on('auth', () => console.log('descargas: hace falta iniciar sesión en la ventana; la cola queda en pausa hasta que reanudes'));
  await dl.init();
}

const cleanIds = (a) => (Array.isArray(a) ? a : []).slice(0, 5000).map((x) => Math.trunc(Number(x))).filter((x) => x > 0 && x < 2 ** 31);
ipcMain.handle('dl:do', async (e, act, arg) => {
  if (!fromSettings(e) || !dl) return { error: 'No disponible' };
  try {
    switch (act) {
      case 'enqueue': return Object.assign({ ok: true }, dl.enqueue(cleanIds(arg && arg.ids), { top: !!(arg && arg.top) }));
      case 'pauseAll': dl.pauseAll(); return { ok: true };
      case 'resumeAll': dl.resumeAll(); return { ok: true };
      case 'retryAll': dl.retryAll(); return { ok: true };
      case 'pause': return { ok: dl.pause(Math.trunc(Number(arg))) };
      case 'resume': return { ok: dl.resume(Math.trunc(Number(arg))) };
      case 'prioritize': return { ok: dl.prioritize(Math.trunc(Number(arg))) };
      case 'cancel': return { ok: await dl.cancel(Math.trunc(Number(arg))) };
      case 'remove': await dl.remove(cleanIds(arg)); return { ok: true };
      case 'clearAll': await dl.clearAll(); return { ok: true };
      case 'reset': await dl.resetStorage(); return { ok: true };
      case 'estimate': return Object.assign({ ok: true }, await dl.estimate(cleanIds(arg && arg.ids), arg && arg.q));
      default: return { error: 'Acción desconocida' };
    }
  } catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('cfg:get', (e) => (fromSettings(e) ? snapshot() : null));
ipcMain.handle('cfg:set', async (e, p) => {
  if (!fromSettings(e) || !p || typeof p !== 'object') return { error: 'No permitido' };
  const patch = {};
  if (typeof p.url === 'string') {
    let u = p.url.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const x = new URL(u); patch.url = (x.origin + x.pathname).replace(/\/+$/, ''); } catch { return { error: 'La URL del servidor no es válida' }; }
  }
  if (typeof p.discordAppId === 'string') {
    const id = p.discordAppId.trim();
    if (id && !/^\d{5,25}$/.test(id)) return { error: 'El Application ID son solo números' };
    patch.discordAppId = id;
  }
  if (['auto', 'on', 'off'].includes(p.presence)) patch.presence = p.presence;
  if (typeof p.closeToTray === 'boolean') patch.closeToTray = p.closeToTray;
  if (typeof p.startMinimized === 'boolean') patch.startMinimized = p.startMinimized;
  if (typeof p.dlQuality === 'string') {
    if (!/^(source|flac16|(mp3|aac|opus)_[a-z0-9]{1,4})$/.test(p.dlQuality)) return { error: 'Calidad de descarga no válida' };
    patch.dlQuality = p.dlQuality;
  }
  if (p.dlConcurrency != null) {
    const n = Math.trunc(Number(p.dlConcurrency));
    if (!(n >= 1 && n <= 4)) return { error: 'Las descargas simultáneas van de 1 a 4' };
    patch.dlConcurrency = n;
  }
  const urlChanged = patch.url && patch.url !== cfg.get().url;
  const oldOrigin = dlOrigin();
  cfg.set(patch);
  if (urlChanged && win && !win.isDestroyed()) win.loadURL(cfg.get().url);
  if (urlChanged && dlOrigin() !== oldOrigin) await makeDownloads();
  else if (dl) dl.kick();
  presence.forceRecheck();
  trayKey = '';
  rebuildTray();
  return { ok: true, state: snapshot() };
});

// ---- salir ----
function quit() { app.quit(); }
app.on('before-quit', (e) => {
  quitting = true;
  if (cleaned) return;
  e.preventDefault();
  cleaned = true;
  Promise.race([Promise.allSettled([presence.stop(), dl ? dl.shutdown() : null]), sleep(3000)]).catch(() => {}).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (!tray || !cfg.get().closeToTray) app.quit(); });
app.on('second-instance', showWin);
app.on('activate', showWin);

app.whenReady().then(() => {
  cfg = new Config(app.getPath('userData'));
  const ses = session.defaultSession;
  // Que el sitio vea un Chrome normal (sin «Electron/» ni el nombre de la app).
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|flaco-desktop)\/\S+/g, ''));
  const allowed = ['fullscreen', 'clipboard-sanitized-write', 'notifications'];
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.includes(perm) && sameOrigin(wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm) => allowed.includes(perm) && (!wc || sameOrigin(wc.getURL())));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Archivo', submenu: [
      { label: 'Ajustes del cliente…', accelerator: 'CmdOrCtrl+,', click: openSettings },
      { type: 'separator' },
      { label: 'Salir', accelerator: 'CmdOrCtrl+Q', click: quit },
    ] },
    { label: 'Ver', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'toggleDevTools' },
    ] },
  ]));

  presence = new PresenceManager({ getConfig: () => cfg.get(), readState: readPageState, log: (...a) => console.log(...a) });
  presence.on('status', () => rebuildTray());

  makeDownloads().catch((e) => console.error('No pude iniciar las descargas:', e.message)); // no bloquea la ventana
  createWindow();
  buildTray();
  presence.start();
  setInterval(async () => { pageState = await readPageState(); rebuildTray(); }, 3000);
});
