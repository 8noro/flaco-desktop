'use strict';
// Carga main.js con un «electron» de mentira y prueba la integración de las descargas (IPC solo desde Ajustes, bandeja, validaciones, cierre).
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'flaco-main-'));
const handlers = {}, wins = [], trayMenus = [], appEvents = {};
let readyCb;
const audio = crypto.randomBytes(300 * 1024);

const fetchLog = [];
const fakeFetch = async (url, opts = {}) => {
  const u = new URL(url);
  fetchLog.push({ url: u.pathname + u.search, credentials: opts.credentials });
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/api/plan') return json({ options: [{ id: 'source', kbps: 900 }], source: { id: 7, title: 'Siete', album_id: 3, dur: 100 } });
  if (u.pathname === '/api/stream/7') return new Response(audio, { status: 200, headers: { 'content-length': String(audio.length), etag: '"a"' } });
  if (u.pathname === '/api/lyrics/7') return json({ lines: [] });
  return new Response('x', { status: 404 });
};

class WC { constructor() { this.h = {}; } on(e, f) { this.h[e] = f; } isLoading() { return false; } getURL() { return 'https://music.test/'; } executeJavaScript() { return Promise.resolve(null); } setWindowOpenHandler() {} getType() { return 'window'; } }
class BW {
  constructor(o) { this.o = o; this.webContents = new WC(); this.h = {}; wins.push(this); }
  once() {} on() {} loadURL() { return Promise.resolve(); } loadFile() {} setMenu() {} show() {} focus() {} hide() {} isVisible() { return true; } isFocused() { return true; }
  isDestroyed() { return false; } isMinimized() { return false; } isMaximized() { return false; } isFullScreen() { return false; } getBounds() { return {}; }
}
const ses = {
  getUserAgent: () => 'Mozilla/5.0 Electron/30', setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, fetch: fakeFetch,
};
const electron = {
  app: {
    commandLine: { appendSwitch() {} }, setDesktopName() {}, requestSingleInstanceLock: () => true, quit() { appEvents.quitCalled = true; },
    getPath: () => userData, getVersion: () => '1.1.0', on(e, f) { appEvents[e] = f; }, whenReady: () => new Promise((r) => { readyCb = r; }),
  },
  BrowserWindow: BW, shell: { openExternal() {} },
  Tray: class { on() {} setToolTip() {} setContextMenu(m) { trayMenus.push(m); } },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  session: { defaultSession: ses },
  safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'kwallet6',
    encryptString: (s) => Buffer.from('E' + s), decryptString: (b) => b.toString().slice(1),
  },
};
const orig = Module._load;
Module._load = function (req, ...a) { return req === 'electron' ? electron : orig.call(this, req, ...a); };

(async () => {
  let n = 0; const t = (m) => { n++; console.log('  ✔', m); };
  require('../main.js');
  readyCb(); await sleep(300);
  const main = wins[0]; assert.ok(main);
  const tray = () => trayMenus[trayMenus.length - 1];
  tray().find((i) => i.label === 'Ajustes del cliente…').click(); await sleep(20);
  const sw = wins.find((w) => w.o && w.o.title && w.o.title.startsWith('Ajustes')); assert.ok(sw);
  const fromS = { sender: sw.webContents }, fromPage = { sender: main.webContents };

  let snap = await handlers['cfg:get'](fromS);
  assert.ok(snap.dl && snap.dl.ready && snap.dl.storage.protected && snap.dl.counts.downloaded === 0); t('arranca el gestor y el llavero (safeStorage) y lo informa en los ajustes');
  assert.ok(fs.existsSync(path.join(userData, 'downloads', 'master.key')) && !fs.readFileSync(path.join(userData, 'downloads', 'master.key'), 'utf8').includes('"plain"'));
  assert.strictEqual((await handlers['dl:do'](fromPage, 'enqueue', { ids: [7] })).error, 'No disponible'); t('la página web NO puede pedir descargas (solo la ventana de Ajustes)');
  assert.strictEqual((await handlers['cfg:get'](fromPage)), null);

  const r = await handlers['dl:do'](fromS, 'enqueue', { ids: [7, 'x', -3, 7.9] });
  assert.deepStrictEqual([r.ok, r.added, r.skipped], [true, 1, 1]); t('IDs saneados (basura y negativos se descartan, 7.9 → 7 sin duplicar)');
  for (let i = 0; i < 100 && !(await handlers['cfg:get'](fromS)).dl.counts.downloaded; i++) await sleep(50);
  snap = await handlers['cfg:get'](fromS); assert.strictEqual(snap.dl.counts.downloaded, 1);
  assert.ok(fetchLog.every((f) => f.credentials === 'include')); t('descarga completa usando la sesión de la ventana (credentials: include, sin API key)');

  assert.match((await handlers['cfg:set'](fromS, { dlQuality: 'rm -rf' })).error, /Calidad/);
  assert.match((await handlers['cfg:set'](fromS, { dlConcurrency: 9 })).error, /1 a 4/);
  const ok = await handlers['cfg:set'](fromS, { dlQuality: 'mp3_320', dlConcurrency: 3 });
  assert.ok(ok.ok && ok.state.cfg.dlQuality === 'mp3_320' && ok.state.cfg.dlConcurrency === 3); t('ajustes de descarga: valida y guarda calidad y simultáneas');

  await handlers['dl:do'](fromS, 'pauseAll'); await handlers['dl:do'](fromS, 'enqueue', { ids: [7] });
  await handlers['dl:do'](fromS, 'enqueue', { ids: [7] });
  await handlers['dl:do'](fromS, 'enqueue', { ids: [5] });
  await sleep(300);
  assert.ok(tray().some((i) => /Descargas: 1 en cola \(en pausa\)/.test(i.label || '')), JSON.stringify(tray().map((i) => i.label)));
  assert.ok(tray().some((i) => i.label === 'Reanudar descargas'));
  t('la bandeja muestra la cola y el botón pausar/reanudar');

  const est = await handlers['dl:do'](fromS, 'estimate', { ids: [8] }); assert.ok(est.ok === true || est.error);
  await handlers['dl:do'](fromS, 'clearAll'); assert.strictEqual((await handlers['cfg:get'](fromS)).dl.counts.downloaded, 0); t('borrar todas las descargas');

  const q = { preventDefault() { q.p = true; } }; appEvents['before-quit'](q); await sleep(100);
  assert.ok(q.p && appEvents.quitCalled); t('al salir espera el cierre ordenado del gestor');
  console.log(`\n${n} pruebas OK`); process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
