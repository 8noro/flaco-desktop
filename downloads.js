'use strict';
// Gestor de descargas de FLACo! Desktop: cola con concurrencia, pausa, prioridad, reintentos y reanudación,
// guardando todo cifrado (ver dl-crypto.js). No usa Electron directamente: recibe `fetch` (la sesión de la ventana,
// con sus cookies), la URL del servidor y la clave, así que se prueba con un servidor de mentira.
//
// En disco (carpeta propia por servidor):
//   <32 hex>      audio cifrado, carátula o letra (nombres al azar, sin extensión)
//   <32 hex>.p    descarga a medias (se reanuda con Range + If-Range)
//   index.bin     índice cifrado: descargados, cola y estado
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { EncWriter, EncReader, sealBlob, openBlob } = require('./dl-crypto');

const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const FILE_RE = /^[0-9a-f]{32}(\.p)?$/;
const MIN_FREE = 64 * 1024 * 1024; // margen que se deja libre en el disco

class AuthError extends Error {}   // 401/403: hace falta iniciar sesión; se pausa toda la cola
class FatalError extends Error {}  // no tiene sentido reintentar

function httpError(status) {
  if (status === 401 || status === 403) return new AuthError('Hace falta iniciar sesión en la ventana de FLACo!');
  if (status === 404 || status === 410) return new FatalError('El tema ya no existe en el servidor');
  if (status === 400) return new FatalError('El servidor rechazó el pedido (400)');
  const e = new Error('El servidor respondió ' + status);
  e.status = status;
  return e;
}

const rand = () => crypto.randomBytes(16).toString('hex');

class DownloadManager extends EventEmitter {
  constructor({ dir, vault, fetch, getBase, getQuality = () => 'source', getConcurrency = () => 2, log = () => {},
    stallMs = 30000, headerMs = 10 * 60 * 1000, retryMs = RETRY_MS, statfs = null }) {
    super();
    Object.assign(this, { dir, vault, fetch, getBase, getQuality, getConcurrency, log, stallMs, headerMs, retryMs });
    this.statfs = statfs || ((p) => (fsp.statfs ? fsp.statfs(p) : Promise.reject(new Error('sin statfs'))));
    this.master = null;
    this.idx = { v: 1, tracks: {}, covers: {}, jobs: {}, paused: false, seq: 0 };
    this.active = new Map();   // id -> { ctl, writer, bytes, total }
    this.running = new Set();  // promesas de las descargas en curso
    this.authBlocked = false;
    this.stopped = false;
    this.ready = false;
    this.fatal = '';           // problema de almacenamiento (clave perdida, índice dañado)
    this.timer = null;
    this.saveT = null;
    this.emitT = null;
    this.saving = Promise.resolve();
  }

  // ---------- arranque / cierre ----------
  async init() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.master = this.vault.load();
      await this._loadIndex();
    } catch (e) {
      this.fatal = e.message || String(e);
      this.log('descargas:', this.fatal);
      this._emit();
      return this;
    }
    for (const j of Object.values(this.idx.jobs)) if (j.state === 'downloading') j.state = 'queued';
    await this._cleanOrphans();
    this.ready = true;
    this._changed();
    this._kick();
    return this;
  }

  async shutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const a of this.active.values()) { a.ctl.why = a.ctl.why || 'shutdown'; a.ctl.abort(); }
    await Promise.allSettled([...this.running]);
    clearTimeout(this.emitT);
    if (this.ready) await this.flush();
  }

  // Cuando la clave se perdió o el índice está dañado: borra todo lo descargado y empieza de cero (acción explícita del usuario).
  async resetStorage() {
    for (const a of this.active.values()) { a.ctl.why = 'cancel'; a.ctl.abort(); }
    await Promise.allSettled([...this.running]);
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { /* ignorar */ }
    await Promise.all(names.filter((n) => FILE_RE.test(n) || n === 'index.bin').map((n) => fsp.rm(path.join(this.dir, n), { force: true })));
    this.master = this.vault.reset();
    this.idx = { v: 1, tracks: {}, covers: {}, jobs: {}, paused: false, seq: 0 };
    this.fatal = ''; this.ready = true; this.authBlocked = false; this.stopped = false;
    await this.flush();
    this._changed();
  }

  // ---------- índice cifrado ----------
  async _loadIndex() {
    let blob;
    try { blob = await fsp.readFile(path.join(this.dir, 'index.bin')); } catch { return; } // primera vez
    try {
      const j = JSON.parse(openBlob(this.master, 'index', blob).toString('utf8'));
      if (j && j.v === 1) this.idx = Object.assign(this.idx, j);
    } catch { throw new Error('El índice de descargas está dañado o se cifró con otra clave.'); }
  }

  _save() {
    if (this.saveT || this.stopped) return;
    this.saveT = setTimeout(() => { this.saveT = null; this.flush().catch((e) => this.log('índice:', e.message)); }, 400);
  }

  flush() {
    clearTimeout(this.saveT); this.saveT = null;
    this.saving = this.saving.catch(() => {}).then(async () => {
      if (!this.master) return;
      const f = path.join(this.dir, 'index.bin');
      const tmp = f + '.tmp';
      await fsp.writeFile(tmp, sealBlob(this.master, 'index', Buffer.from(JSON.stringify(this.idx))), { mode: 0o600 });
      await fsp.rename(tmp, f);
    });
    return this.saving;
  }

  async _cleanOrphans() {
    const keep = new Set();
    for (const t of Object.values(this.idx.tracks)) { keep.add(t.file); if (t.lyr) keep.add(t.lyr.file); }
    for (const c of Object.values(this.idx.covers)) keep.add(c.file);
    for (const j of Object.values(this.idx.jobs)) if (j.part) keep.add(j.part.file);
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { return; }
    for (const n of names) if (FILE_RE.test(n) && !keep.has(n)) await fsp.rm(path.join(this.dir, n), { force: true });
  }

  _p(name) { return path.join(this.dir, name); }
  _rm(name) { return name ? fsp.rm(this._p(name), { force: true }).catch(() => {}) : Promise.resolve(); }

  // ---------- API pública ----------
  // items: [id] o [{id, q}]. Devuelve cuántos entraron y cuántos se saltaron (ya descargados o ya en cola).
  enqueue(items, { top = false } = {}) {
    if (!this.ready) return { added: 0, skipped: 0, error: this.fatal || 'No está listo' };
    let added = 0, skipped = 0;
    const want = this.getQuality() || 'source';
    const minPrio = Math.min(0, ...Object.values(this.idx.jobs).map((j) => j.prio));
    let n = 0;
    for (const it of items) {
      const id = Math.trunc(Number(typeof it === 'object' ? it.id : it));
      const q = (typeof it === 'object' && it.q) || '';
      if (!(id > 0)) { skipped++; continue; }
      const have = this.idx.tracks[id];
      const job = this.idx.jobs[id];
      if (job) {
        if (top) { job.prio = minPrio - 1 - (items.length - n); n++; }
        if (job.state === 'paused' || job.state === 'error') { job.state = 'queued'; job.tries = 0; job.error = ''; job.notBefore = 0; added++; } else skipped++;
        continue;
      }
      if (have && (!q || q === have.qWanted)) { skipped++; continue; } // ya está (con la calidad pedida)
      this.idx.jobs[id] = { id, q: q || want, state: 'queued', prio: top ? minPrio - 1 - (items.length - n) : 0, seq: ++this.idx.seq, tries: 0, error: '', notBefore: 0, part: null, title: '' };
      n++; added++;
    }
    this._changed(); this._kick();
    return { added, skipped };
  }

  pauseAll() {
    this.idx.paused = true;
    for (const a of this.active.values()) { a.ctl.why = 'pause-all'; a.ctl.abort(); }
    this._changed();
  }

  resumeAll() {
    this.idx.paused = false; this.authBlocked = false;
    for (const j of Object.values(this.idx.jobs)) if (j.state === 'queued') j.notBefore = 0;
    this._changed(); this._kick();
  }

  pause(id) {
    const j = this.idx.jobs[id];
    if (!j) return false;
    const a = this.active.get(id);
    if (a) { a.ctl.why = 'pause'; a.ctl.abort(); } else j.state = 'paused';
    this._changed();
    return true;
  }

  resume(id) {
    const j = this.idx.jobs[id];
    if (!j || (j.state !== 'paused' && j.state !== 'error')) return false;
    j.state = 'queued'; j.tries = 0; j.error = ''; j.notBefore = 0;
    this._changed(); this._kick();
    return true;
  }

  retryAll() {
    for (const j of Object.values(this.idx.jobs)) if (j.state === 'error') { j.state = 'queued'; j.tries = 0; j.error = ''; j.notBefore = 0; }
    this.authBlocked = false;
    this._changed(); this._kick();
  }

  // Sube un tema al frente de la cola.
  prioritize(id) {
    const j = this.idx.jobs[id];
    if (!j) return false;
    j.prio = Math.min(0, ...Object.values(this.idx.jobs).map((x) => x.prio)) - 1;
    if (j.state === 'paused' || j.state === 'error') { j.state = 'queued'; j.tries = 0; j.notBefore = 0; }
    this._changed(); this._kick();
    return true;
  }

  async cancel(id) {
    const j = this.idx.jobs[id];
    if (!j) return false;
    delete this.idx.jobs[id];
    const a = this.active.get(id);
    if (a) { a.ctl.why = 'cancel'; a.ctl.abort(); } else if (j.part) await this._rm(j.part.file);
    this._changed();
    return true;
  }

  // Quita temas descargados (y/o los saca de la cola). Borra carátulas que ya nadie usa.
  async remove(ids) {
    for (const raw of ids) {
      const id = Math.trunc(Number(raw));
      await this.cancel(id);
      const t = this.idx.tracks[id];
      if (!t) continue;
      delete this.idx.tracks[id];
      await this._rm(t.file);
      if (t.lyr) await this._rm(t.lyr.file);
      const al = t.meta && t.meta.album_id;
      if (al && this.idx.covers[al] && !Object.values(this.idx.tracks).some((x) => x.meta && x.meta.album_id === al)) {
        await this._rm(this.idx.covers[al].file);
        delete this.idx.covers[al];
      }
    }
    this._changed();
  }

  async clearAll() {
    await this.remove([...Object.keys(this.idx.jobs), ...Object.keys(this.idx.tracks)]);
  }

  // Cuánto pesaría descargar estos temas y si entra en el disco (para el aviso antes de confirmar una descarga grande).
  async estimate(ids, q) {
    const want = q || this.getQuality() || 'source';
    let bytes = 0, count = 0, unknown = 0, seconds = 0;
    const list = [...new Set(ids.map((x) => Math.trunc(Number(x))).filter((x) => x > 0))].filter((id) => !this.idx.tracks[id]);
    let i = 0;
    const work = async () => {
      while (i < list.length) {
        const id = list[i++];
        try {
          const plan = await this._json(`/api/plan?track=${id}`);
          const opts = plan.options || [];
          const o = opts.find((x) => x.id === want) || opts.find((x) => x.id === 'source');
          const dur = (plan.source && plan.source.dur) || 0;
          if (o && o.kbps && dur) { bytes += (o.kbps * 1000 / 8) * dur; seconds += dur; count++; } else { unknown++; count++; }
        } catch { unknown++; count++; }
      }
    };
    await Promise.all([work(), work(), work(), work()]);
    let free = null;
    try { const s = await this.statfs(this.dir); free = Number(s.bavail) * Number(s.bsize); } catch { /* sin dato */ }
    return { count, unknown, bytes: Math.round(bytes), free, enough: free == null ? null : free > bytes * 1.05 + MIN_FREE };
  }

  // ---------- consultas (las usa la tanda 2: reproducción y pantalla sin conexión) ----------
  has(id) { return !!this.idx.tracks[id]; }
  trackMeta(id) { const t = this.idx.tracks[id]; return t ? Object.assign({}, t.meta, { dl: { q: t.q, size: t.size, at: t.at } }) : null; }
  list() { return Object.values(this.idx.tracks).map((t) => Object.assign({}, t.meta, { dl: { q: t.q, size: t.size, at: t.at } })); }
  async openAudio(id) {
    const t = this.idx.tracks[id];
    if (!t) throw new Error('Ese tema no está descargado');
    const r = await EncReader.open(this._p(t.file), this.master);
    r.mime = t.mime;
    return r;
  }
  async readCover(albumId) {
    const c = this.idx.covers[albumId];
    return c ? { type: c.type, data: openBlob(this.master, 'cover', await fsp.readFile(this._p(c.file))) } : null;
  }
  async readLyrics(id) {
    const t = this.idx.tracks[id];
    return t && t.lyr ? JSON.parse(openBlob(this.master, 'lyrics', await fsp.readFile(this._p(t.lyr.file))).toString('utf8')) : null;
  }

  getState() {
    const downloaded = {};
    let bytes = 0;
    for (const t of Object.values(this.idx.tracks)) { downloaded[t.id] = { q: t.q, size: t.size, at: t.at }; bytes += t.size; }
    const jobs = Object.values(this.idx.jobs).sort((a, b) => a.prio - b.prio || a.seq - b.seq).map((j) => {
      const a = this.active.get(j.id);
      const total = a ? a.total : (j.part ? j.part.total : 0);
      const done = a ? a.bytes : 0;
      return { id: j.id, title: j.title || '', q: j.qEff || j.q, state: a ? 'downloading' : j.state, bytes: done, total,
        pct: total ? Math.min(100, Math.round(done * 100 / total)) : 0, error: j.error || '', tries: j.tries || 0 };
    });
    return {
      ready: this.ready, fatal: this.fatal, paused: !!this.idx.paused, authBlocked: this.authBlocked,
      storage: this.vault.status, downloaded, bytes, jobs,
      counts: { downloaded: Object.keys(downloaded).length, queued: jobs.filter((j) => j.state === 'queued' || j.state === 'downloading').length, errors: jobs.filter((j) => j.state === 'error').length },
    };
  }

  // ---------- internos ----------
  kick() { this._kick(); }

  _changed() { this._save(); this._emit(); }

  _emit() { // como mucho 4 veces por segundo
    if (this.emitT || this.stopped && !this.ready) return;
    this.emitT = setTimeout(() => { this.emitT = null; this.emit('state', this.getState()); }, 250);
  }

  _kick() {
    if (this.stopped || !this.ready || this.idx.paused || this.authBlocked) return;
    const now = Date.now();
    const jobs = Object.values(this.idx.jobs).filter((j) => j.state === 'queued' && !this.active.has(j.id));
    const ready = jobs.filter((j) => (j.notBefore || 0) <= now).sort((a, b) => a.prio - b.prio || a.seq - b.seq);
    const max = Math.max(1, Math.min(4, Number(this.getConcurrency()) || 2));
    while (this.active.size < max && ready.length) this._start(ready.shift());
    clearTimeout(this.timer);
    const waits = jobs.filter((j) => (j.notBefore || 0) > now).map((j) => j.notBefore - now);
    if (waits.length) this.timer = setTimeout(() => this._kick(), Math.min(...waits) + 20);
  }

  _start(job) {
    const ctl = new AbortController();
    this.active.set(job.id, { ctl, writer: null, bytes: 0, total: 0 });
    job.state = 'downloading';
    const p = this._run(job, ctl).catch((e) => this.log('descarga:', e && e.stack || e)).finally(() => {
      this.running.delete(p);
      this.active.delete(job.id);
      this._changed();
      this._kick();
    });
    this.running.add(p);
  }

  async _run(job, ctl) {
    try {
      await this._download(job, ctl);
    } catch (e) {
      const why = ctl.why;
      if (why === 'cancel') { if (job.part) await this._rm(job.part.file); return; }
      if (why === 'pause') { job.state = 'paused'; return; }
      if (why === 'pause-all' || why === 'shutdown') { job.state = 'queued'; return; }
      if (e instanceof AuthError) { this.authBlocked = true; job.state = 'queued'; job.error = e.message; this.emit('auth'); return; }
      if (e instanceof FatalError) {
        job.state = 'error'; job.error = e.message;
        if (job.part) { await this._rm(job.part.file); job.part = null; }
        this.emit('failed', { id: job.id, error: e.message });
        return;
      }
      const msg = ctl.why === 'stall' ? 'La conexión se quedó sin datos' : (e && e.message) || String(e);
      job.tries = (job.tries || 0) + 1;
      job.error = msg;
      if (job.tries > this.retryMs.length) { job.state = 'error'; this.emit('failed', { id: job.id, error: msg }); } else {
        job.state = 'queued'; job.notBefore = Date.now() + this.retryMs[job.tries - 1];
      }
      this.log(`tema ${job.id}: ${msg} (intento ${job.tries})`);
    }
  }

  async _get(p, opts = {}) { return this.fetch(this.getBase().replace(/\/+$/, '') + p, opts); }

  async _json(p, signal) {
    const r = await this._get(p, { signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw httpError(r.status);
    return r.json();
  }

  async _dropPart(job) {
    if (job.part) await this._rm(job.part.file);
    job.part = null;
  }

  async _space(need) {
    let s;
    try { s = await this.statfs(this.dir); } catch { return; } // sin dato: no bloquear
    const free = Number(s.bavail) * Number(s.bsize);
    if (Number.isFinite(free) && free < need + MIN_FREE) throw new FatalError('No hay espacio en el disco');
  }

  // Una carátula por álbum; si dos temas del mismo álbum bajan a la vez, solo uno la pide (el otro espera ese resultado).
  _ensureCover(albumId, signal) {
    if (this.idx.covers[albumId]) return Promise.resolve();
    if (!this._covers) this._covers = new Map();
    let p = this._covers.get(albumId);
    if (!p) {
      p = (async () => {
        try {
          const r = await this._get(`/api/cover/album/${albumId}?s=640`, { signal });
          if (!r.ok) return;
          const data = Buffer.from(await r.arrayBuffer());
          if (!data.length || this.idx.covers[albumId]) return;
          const file = rand();
          await fsp.writeFile(this._p(file), sealBlob(this.master, 'cover', data), { mode: 0o600 });
          this.idx.covers[albumId] = { file, size: data.length, type: r.headers.get('content-type') || 'image/jpeg' };
        } catch { /* la carátula es opcional */ } finally { this._covers.delete(albumId); }
      })();
      this._covers.set(albumId, p);
    }
    return p.then(() => { if (signal.aborted) throw new Error('cancelado'); });
  }

  async _download(job, ctl) {
    const { signal } = ctl;
    const id = job.id;
    const a = this.active.get(id);

    // 1) datos del tema + calidades válidas
    const plan = await this._json(`/api/plan?track=${id}`, signal);
    const meta = plan && plan.source;
    if (!meta || !meta.id) throw new FatalError('El servidor no devolvió los datos del tema');
    job.title = meta.title || '';
    const opts = (plan.options || []).map((o) => o.id);
    let q = job.q || this.getQuality() || 'source';
    if (q !== 'source' && !opts.includes(q)) q = 'source'; // p. ej. flac16 en un tema que no es hi-res
    job.qEff = q;
    if (job.part && job.part.q !== q) await this._dropPart(job);

    // 2) audio (con reanudación)
    let writer = null, audio = null;
    if (job.part) {
      try { writer = await EncWriter.resume(this._p(job.part.file), this.master); } catch { await this._dropPart(job); writer = null; }
    }
    try {
      let resp = null;
      for (let attempt = 0; attempt < 2 && !resp; attempt++) {
        const offset = writer ? writer.chunksOffset : 0;
        const headers = {};
        if (offset > 0) { headers.Range = `bytes=${offset}-`; if (job.part.valid) headers['If-Range'] = job.part.valid; }
        // El servidor puede tardar en transcodear antes de contestar: espera hasta headerMs.
        const hdr = setTimeout(() => { ctl.why = ctl.why || 'stall'; ctl.abort(); }, this.headerMs);
        let r;
        try { r = await this._get(`/api/stream/${id}?q=${encodeURIComponent(q)}`, { headers, signal }); } finally { clearTimeout(hdr); }
        if (r.status === 416 || (offset > 0 && r.status === 200)) { // el rango ya no vale o el archivo cambió: de cero
          if (r.body) await r.body.cancel().catch(() => {});
          if (writer) { await writer.close(); writer = null; }
          await this._dropPart(job);
          continue;
        }
        if (r.status !== 200 && r.status !== 206) throw httpError(r.status);
        resp = r;
        resp.offset = offset;
      }
      if (!resp) throw new Error('No pude pedir el audio');

      let total;
      if (resp.status === 206) {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(resp.headers.get('content-range') || '');
        if (!m || Number(m[1]) !== resp.offset) throw new Error('Respuesta de rango inesperada');
        total = Number(m[3]);
      } else total = Number(resp.headers.get('content-length'));
      if (!Number.isFinite(total) || total <= 0) throw new FatalError('El servidor no informó el tamaño del archivo');
      if (writer && writer.total !== total) { await writer.close(); writer = null; await this._dropPart(job); throw new Error('El archivo cambió en el servidor; reintentando'); }

      await this._space(total - (writer ? writer.chunksOffset : 0));
      if (!writer) {
        const file = rand() + '.p';
        const etag = resp.headers.get('etag') || '';
        const valid = etag && !etag.startsWith('W/') ? etag : (resp.headers.get('last-modified') || '');
        writer = await EncWriter.create(this._p(file), this.master, total);
        job.part = { file, total, q, valid };
        await this.flush();
      }
      a.writer = writer; a.total = total; a.bytes = writer.offset;

      const reader = resp.body.getReader();
      let stall = null;
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => { ctl.why = ctl.why || 'stall'; ctl.abort(); }, this.stallMs); };
      try {
        arm();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          await writer.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
          a.bytes = writer.offset;
          this._emit();
        }
      } finally { clearTimeout(stall); try { reader.releaseLock(); } catch { /* ignorar */ } }
      if (signal.aborted) throw new Error('cancelado');
      if (writer.offset !== total) throw new Error('La descarga terminó incompleta');
      await writer.finish();
      const final = job.part.file.replace(/\.p$/, '');
      await fsp.rename(this._p(job.part.file), this._p(final));
      audio = { file: final, size: total, etag: job.part.valid, mime: (resp.headers.get('content-type') || '').split(';')[0] };
      job.part = null;
    } finally {
      if (writer) await writer.close();
      a.writer = null;
    }

    // 3) carátula y letra (si fallan, el tema se guarda igual)
    let lyr = null;
    try {
      const r = await this._get(`/api/lyrics/${id}`, { signal });
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.lines) && j.lines.length) {
          const file = rand();
          const blob = sealBlob(this.master, 'lyrics', Buffer.from(JSON.stringify(j)));
          await fsp.writeFile(this._p(file), blob, { mode: 0o600 });
          lyr = { file, size: blob.length };
        }
      }
    } catch (e) { if (signal.aborted) throw e; }
    if (meta.album_id) await this._ensureCover(meta.album_id, signal);

    // 4) listo: se anota en el índice (si había otra calidad del mismo tema, se borra)
    const old = this.idx.tracks[id];
    this.idx.tracks[id] = { id, q, qWanted: job.q, file: audio.file, size: audio.size, etag: audio.etag, mime: audio.mime, at: Date.now(), meta, lyr };
    delete this.idx.jobs[id];
    if (old) { await this._rm(old.file); if (old.lyr) await this._rm(old.lyr.file); }
    await this.flush();
    this.emit('done', { id, q });
  }
}

module.exports = { DownloadManager, AuthError, FatalError, httpError, MIN_FREE };
