'use strict';
// Puente entre la web de FLACo! (que se muestra dentro de la ventana) y el gestor de descargas (tanda 3).
//
// La página remota NO tiene preload ni Node (decisión del cliente 1.0). El canal es el mismo que ya usa la presencia de Discord:
//   · el cliente inyecta `window.flacoDesktop` con executeJavaScript (solo en páginas del servidor configurado);
//   · página → cliente: `flacoDesktop.call(op, arg)` deja un pedido en una cola; el cliente la vacía cada ~1 s;
//   · cliente → página: `flacoDesktop._set(estado)` + evento `flaco-dl` para que la UI actualice íconos sin recargar.
// Todo lo que viene de la página se trata como NO confiable: operaciones en lista blanca, ids saneados, textos recortados.
const SAFE_Q = /^(source|flac16|(mp3|aac|opus)_[a-z0-9]{1,4})$/;
const KINDS = ['album', 'artist', 'playlist', 'liked'];
const MAX_IDS = 5000;
const MAX_CMDS = 50;

// ---- lado página: se serializa con toString() y se evalúa dentro de la web (no puede usar nada de este archivo) ----
function pageSide(version) {
  if (window.flacoDesktop) return false;
  var q = [], pend = {}, rid = 0;
  var f = {
    version: version,
    st: {},
    // Pide algo al cliente; devuelve una promesa con la respuesta (o error si no contesta en 2 min).
    call: function (op, arg) {
      return new Promise(function (res, rej) {
        if (q.length >= 200) { rej(new Error('Demasiados pedidos pendientes')); return; }
        var id = ++rid;
        pend[id] = { res: res, rej: rej, t: setTimeout(function () { delete pend[id]; rej(new Error('El cliente no respondió')); }, 120000) };
        q.push({ rid: id, op: op, arg: arg });
      });
    },
    // Uso interno del cliente:
    _take: function () { var r = q; q = []; return r; },
    _resolve: function (id, val) {
      var p = pend[id]; if (!p) return;
      clearTimeout(p.t); delete pend[id];
      if (val && val.error) p.rej(new Error(val.error)); else p.res(val);
    },
    _set: function (st) {
      f.st = st || {};
      try { window.dispatchEvent(new CustomEvent('flaco-dl', { detail: f.st })); } catch (e) { /* sin CustomEvent */ }
    },
  };
  window.flacoDesktop = f;
  try { window.dispatchEvent(new CustomEvent('flaco-desktop')); } catch (e) { /* ignorar */ }
  return true;
}

// Se evalúa en cada vuelta: crea el objeto si falta (primera carga o recarga), vacía la cola y dice con qué cuenta está abierta la web.
const tickScript = (version) => `(()=>{try{const fresh=(${pageSide.toString()})(${JSON.stringify(version)});const f=window.flacoDesktop;
  return{fresh:!!fresh,cmds:f._take(),me:(typeof S!=='undefined'&&S&&S.me)?String(S.me.id||''):''}}catch(e){return null}})()`;

const ids = (a) => (Array.isArray(a) ? a : []).slice(0, MAX_IDS).map((x) => Math.trunc(Number(x))).filter((x) => x > 0 && x < 2 ** 31);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

class Bridge {
  constructor({ getWc, getDl, getCfg, isServerUrl, version = '0', openDownloads = () => {}, log = () => {}, intervalMs = 1000 }) {
    Object.assign(this, { getWc, getDl, getCfg, isServerUrl, version, openDownloads, log, intervalMs });
    this.timer = null; this.busy = false; this.dirty = true;
    this.lastOk = 0; this.me = null; this.sentRev = -1; this.dCache = null;
  }

  start() { if (!this.timer) this.timer = setInterval(() => this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); this.timer = null; }
  markDirty() { this.dirty = true; }
  // ¿Se vio el servidor (la web cargada y respondiendo) hace poco? Lo usan las sincronizaciones.
  online(ms = 15000) { return Date.now() - this.lastOk < ms; }

  async tick(force = false) {
    if (this.busy) return;
    const wc = this.getWc();
    if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
    if (!force && wc.isLoading()) return;
    let url = '';
    try { url = wc.getURL(); } catch { return; }
    if (!this.isServerUrl(url)) return;
    this.busy = true;
    try {
      let r;
      try { r = await wc.executeJavaScript(tickScript(this.version), false); } catch { return; }
      if (!r) return;
      this.lastOk = Date.now();
      const dl = this.getDl();
      this.me = r.me || '';
      if (dl && dl.ready) { dl.setUser(this.me); dl.touchOnline(); }
      const cmds = Array.isArray(r.cmds) ? r.cmds.slice(0, MAX_CMDS) : [];
      for (const c of cmds) await this.handle(wc, c);
      if (dl && dl.ready && dl.rev !== this.sentRev) this.dirty = true; // cambió lo descargado
      if (r.fresh || this.dirty || cmds.length) await this.push(wc, !!r.fresh);
    } finally { this.busy = false; }
  }

  async reply(wc, rid, val) {
    if (!rid) return;
    try { await wc.executeJavaScript(`window.flacoDesktop&&window.flacoDesktop._resolve(${rid},${JSON.stringify(val)})`, false); } catch { /* la página se fue */ }
  }

  async handle(wc, c) {
    const rid = c && Number.isInteger(c.rid) && c.rid > 0 ? c.rid : 0;
    let out;
    try { out = await this.run(c && c.op, (c && c.arg) || {}); } catch (e) { out = { error: (e && e.message) || String(e) }; }
    this.dirty = true;
    await this.reply(wc, rid, out == null ? { ok: true } : out);
  }

  async run(op, a) {
    const dl = this.getDl();
    if (op === 'settings') { this.openDownloads(); return { ok: true }; }
    if (!dl || !dl.ready) throw new Error(dl && dl.fatal ? dl.fatal : 'Las descargas no están disponibles');
    switch (op) {
      case 'download': {
        const items = (Array.isArray(a.items) ? a.items : []).slice(0, MAX_IDS).map((x) => ({
          id: Math.trunc(Number(x && x.id)), q: SAFE_Q.test(String((x && x.q) || '')) ? x.q : '',
          title: str(x && x.title, 200), album: str(x && x.album, 200), album_id: Math.trunc(Number(x && x.album_id)) || 0,
        })).filter((x) => x.id > 0 && x.id < 2 ** 31);
        return Object.assign({ ok: true }, dl.enqueue(items, { top: !!a.top }));
      }
      case 'remove': await dl.remove(ids(a.ids)); return { ok: true };
      case 'cancel': for (const id of ids(a.ids)) await dl.cancel(id); return { ok: true };
      case 'retry': for (const id of ids(a.ids)) dl.resume(id); return { ok: true };
      case 'pauseAll': dl.pauseAll(); return { ok: true };
      case 'resumeAll': dl.resumeAll(); return { ok: true };
      case 'estimate': return Object.assign({ ok: true }, await dl.estimate(ids(a.ids), SAFE_Q.test(String(a.q || '')) ? a.q : ''));
      case 'keep': {
        if (!KINDS.includes(a.kind)) throw new Error('Tipo no válido');
        const id = a.kind === 'liked' ? 0 : Math.trunc(Number(a.id));
        if (!(id >= 0) || (a.kind !== 'liked' && id < 1)) throw new Error('Id no válido');
        dl.setKeep(a.kind, id, str(a.name, 120), !!a.on);
        const r = a.on ? await dl.syncKeep(dl.keepKey(a.kind, id)) : { added: 0 };
        return { ok: true, added: r.added };
      }
      default: throw new Error('Operación desconocida');
    }
  }

  // Estado compacto para la página: d = descargados {id:[calidad, álbum, artista]}, j = en curso {id:[estado, %]}.
  buildState() {
    const dl = this.getDl(), c = this.getCfg();
    const base = { ask: !!c.dlAsk, q: c.dlQuality || 'source', v: this.version };
    if (!dl || !dl.ready) return Object.assign(base, { ready: false, fatal: dl && dl.fatal ? dl.fatal : '', d: {}, j: {}, er: {}, k: [] });
    const s = dl.getState();
    if (this.dlRef !== dl) { this.dlRef = dl; this.dCache = null; }
    if (this.dCache === null || this.sentRev !== s.rev) {
      const d = {};
      for (const [id, t] of Object.entries(s.downloaded)) d[id] = [t.q, t.al, t.ar];
      this.dCache = d; this.sentRev = s.rev;
    }
    const j = {}, er = {};
    let n = 0;
    for (const x of s.jobs) {
      j[x.id] = [x.state === 'downloading' ? 'd' : x.state === 'paused' ? 'p' : x.state === 'error' ? 'e' : 'q', x.pct];
      if (x.state === 'error' && n++ < 30) er[x.id] = str(x.error, 120);
    }
    return Object.assign(base, { ready: true, fatal: s.fatal, paused: s.paused, auth: s.authBlocked, expired: s.expired, d: this.dCache, j, er, k: s.keep, bytes: s.bytes });
  }

  async push(wc, force) {
    const st = this.buildState();
    const json = JSON.stringify(st);
    if (!force && json === this.lastJson) { this.dirty = false; return; }
    this.lastJson = json; this.dirty = false;
    try { await wc.executeJavaScript(`window.flacoDesktop&&window.flacoDesktop._set(${json})`, false); } catch { /* la página se fue */ }
  }
}

module.exports = { Bridge, pageSide, tickScript, SAFE_Q };
