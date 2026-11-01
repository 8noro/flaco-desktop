'use strict';
// Protocolo flaco-dl:// de FLACo! Desktop (tanda 2): sirve la pantalla «sin conexión» y, descifrando al vuelo, lo descargado.
// Un solo origen (flaco-dl://local) para que el navegador trate la pantalla y sus datos como «mismo origen»: una página
// remota (https) NO puede hacer fetch() a estos datos (sin CORS) y además se manda Cross-Origin-Resource-Policy: same-origin.
//   /app/<archivo>        la pantalla (lista blanca: offline.html, offline.js, offline.css, ui.css)
//   /api/list, /api/state temas descargados / estado del almacenamiento (JSON)
//   /audio/<id>           audio descifrado, con Range (seek) — streaming bloque a bloque, sin cargar el archivo entero
//   /cover/<albumId>      carátula
//   /lyrics/<id>          letra (JSON, tal como la dio el servidor)
const fs = require('fs');
const path = require('path');
const { CHUNK } = require('./dl-crypto');

const SCHEME = 'flaco-dl';
const ORIGIN = `${SCHEME}://local`;
const STATIC = {
  'offline.html': 'text/html; charset=utf-8', 'offline.js': 'text/javascript; charset=utf-8',
  'offline.css': 'text/css; charset=utf-8', 'ui.css': 'text/css; charset=utf-8',
};
const BASE = { 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff' };

const MIME_CODEC = { flac: 'audio/flac', mp3: 'audio/mpeg', aac: 'audio/mp4', alac: 'audio/mp4', m4a: 'audio/mp4', opus: 'audio/ogg', vorbis: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav', pcm: 'audio/wav' };
function mimeFor(stored, q, codec) {
  if (stored && /^audio\//.test(stored)) return stored;
  const m = /^(mp3|aac|opus|flac)/.exec(q || '');
  if (m && q !== 'source') return MIME_CODEC[m[1]];
  const c = String(codec || '').toLowerCase();
  for (const k of Object.keys(MIME_CODEC)) if (c.includes(k)) return MIME_CODEC[k];
  return 'application/octet-stream';
}

// null = sin Range (o uno que no entendemos: se ignora, como permite el RFC) · 'bad' = no satisfacible · {a, b} = bytes a..b
function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let a, b;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'bad'; a = Math.max(0, size - n); b = size - 1; } else {
    a = Number(m[1]); b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return a >= size || a > b ? 'bad' : { a, b };
}

function createHandler({ getDl, uiDir, probe = null }) {
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...BASE, 'content-type': 'application/json; charset=utf-8' } });
  const text = (s, status) => new Response(s, { status, headers: { ...BASE, 'content-type': 'text/plain; charset=utf-8' } });

  async function audio(request, id) {
    const dl = getDl();
    if (!dl || !dl.ready) return text('Descargas no disponibles', 503);
    if (!dl.has(id)) return text('Ese tema no está descargado', 404);
    if (typeof dl.isExpired === 'function' && dl.isExpired()) return text('Descargas caducadas: hace falta conectarse a FLACo! para renovarlas', 403);
    let r;
    try { r = await dl.openAudio(id); } catch (e) { return text('No pude abrir el archivo: ' + e.message, 500); }
    const meta = dl.trackMeta(id) || {};
    const type = mimeFor(r.mime, meta.dl && meta.dl.q, meta.codec);
    const rg = parseRange(request.headers.get('range'), r.size);
    if (rg === 'bad') { await r.close(); return new Response(null, { status: 416, headers: { ...BASE, 'content-range': `bytes */${r.size}` } }); }
    const a = rg ? rg.a : 0, b = rg ? rg.b : r.size - 1;
    let pos = a, closed = false;
    const close = async () => { if (!closed) { closed = true; await r.close(); } };
    const body = new ReadableStream({
      async pull(ctl) {
        if (pos > b) { ctl.close(); await close(); return; }
        try {
          const end = Math.min(b, pos + CHUNK - (pos % CHUNK) - 1); // hasta el borde del bloque: cada bloque se descifra una sola vez
          const buf = await r.read(pos, end);
          pos = end + 1;
          ctl.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        } catch (e) { await close(); ctl.error(e); }
      },
      cancel() { return close(); },
    });
    const headers = { ...BASE, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(b - a + 1) };
    if (rg) headers['content-range'] = `bytes ${a}-${b}/${r.size}`;
    return new Response(body, { status: rg ? 206 : 200, headers });
  }

  return async function handle(request) {
    let u;
    try { u = new URL(request.url); } catch { return text('URL inválida', 400); }
    const post = request.method === 'POST';
    if (u.host !== 'local' || (!post && request.method !== 'GET' && request.method !== 'HEAD')) return text('No permitido', 403);
    const parts = u.pathname.split('/').filter(Boolean);
    const [kind, arg] = parts;
    // Lo único que se escribe desde la pantalla: anotar una reproducción hecha sin conexión (se cuenta en el servidor al volver).
    if (post) {
      if (!(kind === 'api' && arg === 'played' && parts.length === 2)) return text('No permitido', 403);
      const dl0 = getDl();
      if (!dl0 || !dl0.ready) return text('Descargas no disponibles', 503);
      let b;
      try { const raw = await request.text(); if (raw.length > 2000) throw new Error('grande'); b = JSON.parse(raw); } catch { return text('Pedido inválido', 400); }
      return json({ ok: !!dl0.logPlay(b && typeof b === 'object' ? b : {}) });
    }
    if (parts.length === 0) return Response.redirect(`${ORIGIN}/app/offline.html`, 302);

    if (kind === 'app' && parts.length === 2) {
      const type = Object.prototype.hasOwnProperty.call(STATIC, arg) ? STATIC[arg] : null;
      if (!type) return text('No existe', 404);
      try { return new Response(await fs.promises.readFile(path.join(uiDir, arg)), { headers: { ...BASE, 'content-type': type } }); } catch { return text('No existe', 404); }
    }

    const dl = getDl();
    // ¿ya volvió el servidor? Lo comprueba el proceso principal (desde acá, un fetch no-cors a un 530 de Cloudflare parecería «conectado»).
    if (kind === 'api' && arg === 'online') return json({ online: probe ? !!(await probe().catch(() => false)) : false });
    if (kind === 'api' && arg === 'state') {
      if (!dl) return json({ ready: false, fatal: '', count: 0, bytes: 0 });
      const s = dl.getState();
      return json({ ready: s.ready, fatal: s.fatal, count: s.counts.downloaded, bytes: s.bytes, protected: s.storage.protected, plays: dl.playsPending().length, expired: !!s.expired, expireDays: typeof dl.getExpireDays === 'function' ? Number(dl.getExpireDays()) || 0 : 0 });
    }
    if (kind === 'api' && arg === 'list') {
      if (!dl || !dl.ready) return json({ ready: false, tracks: [] });
      return json({ ready: true, tracks: dl.list().map((t) => ({
        id: t.id, title: t.title, no: t.no, disc: t.disc, dur: t.dur, year: t.year, codec: t.codec, sr: t.sr, bits: t.bits,
        album_id: t.album_id, album: t.album, artist_id: t.artist_id, artist: t.artist, tier: t.tier, q: t.dl.q, size: t.dl.size, lyr: t.dl.lyr,
      })) });
    }
    const id = Math.trunc(Number(arg));
    if (!(id > 0) || parts.length !== 2) return text('No existe', 404);
    if (kind === 'audio') return audio(request, id);
    if (!dl || !dl.ready) return text('Descargas no disponibles', 503);
    try {
      if (kind === 'cover') {
        const c = await dl.readCover(id);
        return c ? new Response(c.data, { headers: { ...BASE, 'cache-control': 'private, max-age=600', 'content-type': c.type } }) : text('Sin carátula', 404);
      }
      if (kind === 'lyrics') {
        const l = await dl.readLyrics(id);
        return l ? json(l) : text('Sin letra', 404);
      }
    } catch (e) { return text('Error: ' + e.message, 500); }
    return text('No existe', 404);
  };
}

module.exports = { createHandler, parseRange, mimeFor, SCHEME, ORIGIN };
