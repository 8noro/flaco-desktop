'use strict';
// Pruebas sin Electron del cifrado y del gestor de descargas, con un servidor FLACo! de mentira (HTTP real, con Range/ETag/If-Range).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { EncWriter, EncReader, sealBlob, openBlob, KeyVault, KeyLostError, CHUNK, HDR, TAG, fileSize } = require('../dl-crypto');
const { DownloadManager } = require('../downloads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flaco-dl-'));
let ok = 0;
const t = (name) => { ok++; console.log('  ✔', name); };
const until = async (fn, ms = 8000, what = '') => {
  const t0 = Date.now();
  while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timeout esperando ' + what); await sleep(10); }
};

// ---------- servidor de mentira ----------
function fakeServer() {
  const S = { tracks: {}, log: [], hooks: {}, authed: true };
  const mk = (id, size, extra = {}) => {
    S.tracks[id] = Object.assign({ id, title: 'Tema ' + id, album_id: 100 + Math.floor(id / 10), dur: 200, kbps: 900, hires: false,
      data: crypto.randomBytes(size), alt: crypto.randomBytes(size >> 1), ver: 1, lyrics: id % 2 === 0 }, extra);
    return S.tracks[id];
  };
  S.add = mk;
  S.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    S.log.push({ url: req.url, range: req.headers.range, ifRange: req.headers['if-range'] });
    const send = (code, body, type = 'application/json', h = {}) => { res.writeHead(code, Object.assign({ 'content-type': type }, h)); res.end(body); };
    if (!S.authed) return send(401, '{}');
    let m;
    if ((m = /^\/api\/plan$/.exec(u.pathname))) {
      const tr = S.tracks[+u.searchParams.get('track')];
      if (!tr) return send(404, '{}');
      const options = [{ id: 'source', kbps: tr.kbps }];
      if (tr.hires) options.push({ id: 'flac16', kbps: 900 });
      options.push({ id: 'mp3_320', kbps: 320 });
      return send(200, JSON.stringify({ track: tr.id, options, source: { id: tr.id, title: tr.title, album_id: tr.album_id, dur: tr.dur, artist: 'Artista', album: 'Álbum' } }));
    }
    if ((m = /^\/api\/stream\/(\d+)$/.exec(u.pathname))) {
      const tr = S.tracks[+m[1]];
      if (!tr) return send(404, '{}');
      if (S.hooks.status) { const c = S.hooks.status(tr, req); if (c) return send(c, 'x'); }
      const q = u.searchParams.get('q') || 'source';
      const data = q === 'flac16' ? tr.alt : tr.data;
      const etag = `"t${tr.id}-${q}-v${tr.ver}"`;
      let start = 0, end = data.length - 1, code = 200;
      const h = { 'content-type': 'audio/flac', etag, 'accept-ranges': 'bytes' };
      const rg = /^bytes=(\d+)-/.exec(req.headers.range || '');
      if (rg && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
        start = +rg[1];
        if (start >= data.length) return send(416, '', 'text/plain');
        code = 206; h['content-range'] = `bytes ${start}-${end}/${data.length}`;
      }
      h['content-length'] = end - start + 1;
      res.writeHead(code, h);
      const body = data.subarray(start, end + 1);
      const first = S.hooks.dropOnce && !S.hooks.dropped && (S.hooks.dropped = true);
      let sent = 0;
      const piece = 48 * 1024;
      while (sent < body.length) {
        if (res.destroyed) return;
        if (first && sent >= S.hooks.dropOnce) { await sleep(60); return res.destroy(); }
        if (S.hooks.stallAfter != null && sent >= S.hooks.stallAfter) return; // se cuelga sin cerrar
        res.write(body.subarray(sent, sent + piece));
        sent += piece;
        if (S.hooks.slow) await sleep(S.hooks.slow);
      }
      return res.end();
    }
    if ((m = /^\/api\/lyrics\/(\d+)$/.exec(u.pathname))) {
      const tr = S.tracks[+m[1]];
      return send(200, JSON.stringify(tr && tr.lyrics ? { synced: true, lines: [[0, 'hola'], [5, 'mundo']] } : { synced: false, lines: [] }));
    }
    if ((m = /^\/api\/cover\/album\/(\d+)$/.exec(u.pathname))) return send(200, Buffer.from('JPEGDATA-' + m[1]), 'image/jpeg');
    send(404, '{}');
  });
  return new Promise((res) => S.server.listen(0, '127.0.0.1', () => { S.base = 'http://127.0.0.1:' + S.server.address().port; res(S); }));
}

function mkManager(S, dir, vault, extra = {}) {
  const cfg = Object.assign({ q: 'source', conc: 2 }, extra.cfg || {});
  const m = new DownloadManager(Object.assign({
    dir, vault, fetch: (u, o) => fetch(u, o), getBase: () => S.base, getQuality: () => cfg.q, getConcurrency: () => cfg.conc,
    retryMs: [20, 20, 20], stallMs: 300, statfs: async () => ({ bavail: 1e9, bsize: 4096 }),
  }, extra.opts || {}));
  m.cfg = cfg;
  return m;
}
const plainVault = (dir) => new KeyVault({ dir, safeStorage: null });
const settled = (m, ids) => until(() => ids.every((id) => m.has(id)), 8000, 'descargas ' + ids);
const readAll = async (m, id) => { const r = await m.openAudio(id); const b = await r.read(0, r.size - 1); await r.close(); return b; };

(async () => {
  // ================= cifrado =================
  const master = crypto.randomBytes(32);
  const dir0 = tmp();
  const sizes = [1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17];
  for (const n of sizes) {
    const data = crypto.randomBytes(n), f = path.join(dir0, 'f' + n);
    const w = await EncWriter.create(f, master, n);
    for (let o = 0; o < n; o += 70001) await w.write(data.subarray(o, Math.min(n, o + 70001)));
    await w.finish();
    assert.strictEqual(fs.statSync(f).size, fileSize(n));
    const r = await EncReader.open(f, master);
    assert.ok((await r.read(0, n - 1)).equals(data));
    for (let k = 0; k < 20; k++) { // lecturas al azar (seek)
      const a = Math.floor(Math.random() * n), b = Math.min(n - 1, a + Math.floor(Math.random() * 400000));
      assert.ok((await r.read(a, b)).equals(data.subarray(a, b + 1)), `rango ${a}-${b} de ${n}`);
    }
    assert.strictEqual((await r.read(n + 5, n + 10)).length, 0);
    await r.close();
  }
  t('cifrar/descifrar tamaños de borde (1, CHUNK±1, CHUNK, 3 bloques+) y lecturas aleatorias (seek)');

  { // el archivo no contiene el audio en claro y dos archivos iguales cifran distinto
    const data = Buffer.concat([Buffer.from('FLACMARKERFLACMARKER'), Buffer.alloc(300000, 7)]);
    const a = path.join(dir0, 'a'), b = path.join(dir0, 'b');
    for (const f of [a, b]) { const w = await EncWriter.create(f, master, data.length); await w.write(data); await w.finish(); }
    assert.ok(!fs.readFileSync(a).includes('FLACMARKER'));
    assert.ok(!fs.readFileSync(a).equals(fs.readFileSync(b)));
    assert.ok(!(await fs.promises.readFile(a)).includes(Buffer.alloc(64, 7)));
  }
  t('el archivo cifrado no deja audio en claro (ni siquiera datos repetitivos) y cada archivo usa su propia clave');

  { // manipulación
    const n = 3 * CHUNK, data = crypto.randomBytes(n), f = path.join(dir0, 'tam');
    const w = await EncWriter.create(f, master, n); await w.write(data); await w.finish();
    const orig = fs.readFileSync(f);
    const tryRead = async (buf, wrongKey) => {
      const g = f + '.x'; fs.writeFileSync(g, buf);
      let r;
      try { r = await EncReader.open(g, wrongKey || master); await r.read(0, n - 1); return 'leyó'; } catch { return 'falló'; } finally { if (r) await r.close(); }
    };
    const flip = Buffer.from(orig); flip[HDR + 100] ^= 1;
    assert.strictEqual(await tryRead(flip), 'falló');
    const sw = Buffer.from(orig), L = CHUNK + TAG; // intercambiar bloques 0 y 1
    orig.copy(sw, HDR, HDR + L, HDR + 2 * L); orig.copy(sw, HDR + L, HDR, HDR + L);
    assert.strictEqual(await tryRead(sw), 'falló');
    const hd = Buffer.from(orig); hd[19] ^= 1; // tocar el tamaño en la cabecera
    assert.strictEqual(await tryRead(hd), 'falló');
    assert.strictEqual(await tryRead(orig, crypto.randomBytes(32)), 'falló');
    await assert.rejects(EncReader.open(f + '.y' && (fs.writeFileSync(f + '.y', orig.subarray(0, orig.length - 5)), f + '.y'), master), /incompleto|alterado/);
  }
  t('detecta bits cambiados, bloques intercambiados, cabecera alterada, clave equivocada y archivo truncado');

  { // reanudar
    const n = 5 * CHUNK + 1234, data = crypto.randomBytes(n), f = path.join(dir0, 'res');
    let w = await EncWriter.create(f, master, n);
    await w.write(data.subarray(0, 2 * CHUNK + 999));
    assert.strictEqual(w.chunksOffset, 2 * CHUNK); await w.close();
    fs.appendFileSync(f, crypto.randomBytes(100)); // basura de una escritura cortada
    w = await EncWriter.resume(f, master);
    assert.strictEqual(w.offset, 2 * CHUNK);
    await w.write(data.subarray(2 * CHUNK)); await w.finish();
    const r = await EncReader.open(f, master); assert.ok((await r.read(0, n - 1)).equals(data)); await r.close();
    // un último bloque "completo" pero corrupto se descarta
    w = await EncWriter.create(f + '2', master, n); await w.write(data.subarray(0, 3 * CHUNK)); await w.close();
    const raw = fs.readFileSync(f + '2'); raw[raw.length - 20] ^= 0xff; fs.writeFileSync(f + '2', raw);
    w = await EncWriter.resume(f + '2', master); assert.strictEqual(w.offset, 2 * CHUNK); await w.close();
  }
  t('reanudar un .part: descarta el trozo cortado y verifica el último bloque');

  { // blobs + llavero
    const b = sealBlob(master, 'x', Buffer.from('hola')); assert.strictEqual(openBlob(master, 'x', b).toString(), 'hola');
    assert.throws(() => openBlob(master, 'y', b)); const c = Buffer.from(b); c[14] ^= 1; assert.throws(() => openBlob(master, 'x', c));
    const d = tmp();
    const fake = (backend = 'kwallet6', fail = false) => ({
      isEncryptionAvailable: () => backend !== null, getSelectedStorageBackend: () => backend,
      encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
      decryptString: (b) => { if (fail) throw new Error('x'); return Buffer.from(b.toString().slice(4), 'hex').toString(); },
    });
    const v1 = new KeyVault({ dir: d, safeStorage: fake() }); const k1 = v1.load();
    assert.ok(v1.status.protected && v1.status.backend === 'kwallet6');
    assert.ok(!fs.readFileSync(path.join(d, 'master.key'), 'utf8').includes(k1.toString('base64')));
    assert.ok(new KeyVault({ dir: d, safeStorage: fake() }).load().equals(k1));
    assert.throws(() => new KeyVault({ dir: d, safeStorage: fake('kwallet6', true) }).load(), KeyLostError);
    const d2 = tmp(); const v2 = new KeyVault({ dir: d2, safeStorage: fake('basic_text') }); v2.load();
    assert.ok(!v2.status.protected); assert.strictEqual(fs.statSync(path.join(d2, 'master.key')).mode & 0o777, 0o600);
    const v3 = new KeyVault({ dir: d2, safeStorage: fake('gnome_libsecret') }); const k3 = v3.load(); // aparece un llavero: se sube
    assert.ok(k3.equals(v2.key) && v3.status.protected);
  }
  t('llavero: clave protegida con safeStorage, sin llavero queda 0600 con aviso, se sube al llavero cuando aparece, clave perdida → error claro');

  // ================= gestor =================
  const S = await fakeServer();
  for (const id of [1, 2, 3, 4, 5, 6]) S.add(id, 700 * 1024 + id * 1000);
  S.add(11, 400 * 1024, { hires: true });
  S.add(12, 500 * 1024);

  { // básico: concurrencia, cifrado en disco, lectura
    const dir = tmp(), vault = plainVault(path.join(dir, 'v')), m = mkManager(S, path.join(dir, 'd'), vault);
    await m.init();
    let maxAct = 0; const tick = setInterval(() => { maxAct = Math.max(maxAct, m.active.size); }, 5);
    S.hooks.slow = 5;
    assert.deepStrictEqual(m.enqueue([1, 2, 3, 4, 5, 6]), { added: 6, skipped: 0 });
    assert.deepStrictEqual(m.enqueue([1, 2]), { added: 0, skipped: 2 });
    await settled(m, [1, 2, 3, 4, 5, 6]); clearInterval(tick); S.hooks.slow = 0;
    assert.strictEqual(maxAct, 2); t('6 temas con 2 simultáneas (nunca más de 2 a la vez)');
    for (const id of [1, 6]) assert.ok((await readAll(m, id)).equals(S.tracks[id].data));
    t('el audio descargado coincide byte a byte al descifrarlo (con seek)');
    const names = fs.readdirSync(path.join(dir, 'd'));
    assert.ok(names.every((n) => /^[0-9a-f]{32}$/.test(n) || n === 'index.bin'), names.join());
    assert.strictEqual(names.length, 6 + 3 + 1 + 1, names.join()); // 6 audios + 3 letras + 1 carátula (6 temas bajando de a 2 del mismo álbum) + índice
    assert.throws(() => JSON.parse(fs.readFileSync(path.join(dir, 'd', 'index.bin'), 'utf8')));
    assert.ok(!fs.readFileSync(path.join(dir, 'd', 'index.bin')).includes('Tema'));
    t('nombres de archivo al azar sin extensión, índice cifrado (no se ve ni un título)');
    assert.deepStrictEqual(await m.readLyrics(2), { synced: true, lines: [[0, 'hola'], [5, 'mundo']] });
    assert.strictEqual(await m.readLyrics(1), null);
    assert.strictEqual((await m.readCover(100)).data.toString(), 'JPEGDATA-100');
    assert.strictEqual(m.trackMeta(3).title, 'Tema 3'); assert.strictEqual(m.list().length, 6);
    t('guarda datos del tema, letra (solo si existe) y carátula (una por álbum), todo cifrado');
    const st = m.getState(); assert.strictEqual(st.counts.downloaded, 6); assert.strictEqual(st.jobs.length, 0);
    assert.ok(st.bytes > 4e6 && st.storage.protected === false);
    // persistencia: otro gestor con el mismo disco ve lo mismo
    await m.shutdown();
    const m2 = mkManager(S, path.join(dir, 'd'), plainVault(path.join(dir, 'v'))); await m2.init();
    assert.strictEqual(m2.getState().counts.downloaded, 6); assert.ok((await readAll(m2, 4)).equals(S.tracks[4].data));
    t('el índice y los archivos sobreviven al reinicio');

    // quitar: borra audio y letra, y la carátula solo cuando se va el último del álbum
    const before = fs.readdirSync(path.join(dir, 'd')).length;
    await m2.remove([2]); assert.ok(!m2.has(2)); assert.strictEqual(fs.readdirSync(path.join(dir, 'd')).length, before - 2);
    assert.ok(await m2.readCover(100));
    await m2.remove([1, 3, 4, 5, 6]);
    assert.strictEqual(await m2.readCover(100), null); assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'd')), ['index.bin']);
    t('quitar descargas borra audio, letra y carátula huérfana del disco');
    await m2.shutdown();
  }

  { // corte a mitad → reintento con Range + If-Range
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v'))); await m.init();
    S.log.length = 0; S.hooks.dropOnce = 520 * 1024; S.hooks.dropped = false;
    m.enqueue([1]); await settled(m, [1]);
    const reqs = S.log.filter((l) => l.url.startsWith('/api/stream/1'));
    assert.ok(reqs.length >= 2 && !reqs[0].range && /^bytes=\d+-$/.test(reqs[1].range) && reqs[1].ifRange === '"t1-source-v1"', JSON.stringify(reqs));
    assert.ok(+reqs[1].range.match(/\d+/)[0] >= CHUNK); // retomó donde quedó, no de cero
    assert.ok((await readAll(m, 1)).equals(S.tracks[1].data));
    S.hooks.dropOnce = 0; t('corte de red a mitad: reintenta solo y retoma con Range + If-Range, sin bajar de nuevo lo ya guardado'); await m.shutdown();
  }

  { // cerrar la app a mitad y abrir otra vez
    const dir = tmp(), vault = plainVault(path.join(dir, 'v')), m = mkManager(S, path.join(dir, 'd'), vault); await m.init();
    S.hooks.slow = 15; m.enqueue([2]);
    await until(() => m.active.get(2) && m.active.get(2).bytes > 300 * 1024, 5000, 'avance');
    await m.shutdown();
    const parts = fs.readdirSync(path.join(dir, 'd')).filter((n) => n.endsWith('.p')); assert.strictEqual(parts.length, 1);
    S.log.length = 0; S.hooks.slow = 0;
    const m2 = mkManager(S, path.join(dir, 'd'), plainVault(path.join(dir, 'v'))); await m2.init();
    assert.strictEqual(m2.getState().jobs.length, 1); await settled(m2, [2]);
    assert.ok(S.log.some((l) => l.url.startsWith('/api/stream/2') && l.range), 'no usó Range');
    assert.ok((await readAll(m2, 2)).equals(S.tracks[2].data)); t('cerrar y reabrir la app: la cola sigue y la descarga continúa desde el último bloque'); await m2.shutdown();
  }

  { // el archivo cambió en el servidor → de cero
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v'))); await m.init();
    S.hooks.dropOnce = 520 * 1024; S.hooks.dropped = false;
    const old = Buffer.from(S.tracks[3].data); S.log.length = 0;
    S.hooks.status = null; m.enqueue([3]);
    await until(() => m.idx.jobs[3] && m.idx.jobs[3].part && m.idx.jobs[3].tries >= 1, 4000, 'primer corte');
    S.tracks[3].ver = 2; S.tracks[3].data = crypto.randomBytes(old.length + 5000); // cambió
    await settled(m, [3]);
    assert.ok((await readAll(m, 3)).equals(S.tracks[3].data));
    S.hooks.dropOnce = 0; t('si el archivo cambió en el servidor (If-Range falla → 200) descarta lo parcial y baja el nuevo completo'); await m.shutdown();
  }

  { // pausa, prioridad, cancelar
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v')), { cfg: { conc: 1 } }); await m.init();
    const order = []; m.on('done', (e) => order.push(e.id));
    S.hooks.slow = 5; m.pauseAll(); m.enqueue([1, 2, 3, 4]);
    await sleep(50); assert.strictEqual(m.active.size, 0); t('pausar todo: no arranca nada aunque haya cola');
    m.prioritize(4); m.resumeAll();
    await settled(m, [1, 2, 3, 4]); assert.deepStrictEqual(order, [4, 1, 2, 3]); t('prioridad: el tema subido al frente baja primero y el resto mantiene su orden');
    m.enqueue([5, 6]); await until(() => m.active.has(5), 3000, 'arranque'); await m.cancel(5);
    await until(() => m.has(6), 5000, 'el siguiente sigue'); assert.ok(!m.has(5) && !m.idx.jobs[5]);
    assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.p')).length, 0); t('cancelar: corta la descarga, borra lo parcial y la cola sigue');
    S.hooks.slow = 10;
    m.enqueue([5]); await until(() => m.active.has(5) && m.active.get(5).bytes > 300 * 1024, 5000, 'avance'); m.pause(5); S.hooks.slow = 0;
    await until(() => m.idx.jobs[5] && m.idx.jobs[5].state === 'paused', 3000, 'pausa'); assert.ok(m.idx.jobs[5].part);
    m.resume(5); await settled(m, [5]); assert.ok((await readAll(m, 5)).equals(S.tracks[5].data)); t('pausar y reanudar un tema (retoma con lo parcial)');
    await m.shutdown();
  }

  { // errores: 401, 404, 5xx, cuelgue
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v'))); await m.init();
    let auth = 0; m.on('auth', () => auth++);
    S.authed = false; m.enqueue([1, 2]);
    await until(() => m.authBlocked, 3000, 'auth'); assert.ok(auth >= 1);
    assert.ok(m.getState().jobs.every((j) => j.state === 'queued')); assert.strictEqual(m.active.size, 0);
    S.authed = true; m.resumeAll(); await settled(m, [1, 2]); t('401/403: se frena toda la cola sin perder nada y sigue al reanudar (tras iniciar sesión)');

    m.enqueue([999]); await until(() => m.idx.jobs[999] && m.idx.jobs[999].state === 'error', 3000, 'error 404');
    assert.match(m.idx.jobs[999].error, /ya no existe/); assert.strictEqual(m.idx.jobs[999].tries || 0, 0); t('404: error definitivo, sin reintentos');

    let n5 = 0; S.hooks.status = (tr) => (tr.id === 3 && n5++ < 2 ? 503 : 0);
    m.enqueue([3]); await settled(m, [3]); assert.ok(n5 >= 3); t('5xx pasajero: reintenta con espera y termina');
    S.hooks.status = (tr) => (tr.id === 4 ? 503 : 0);
    m.enqueue([4]); await until(() => m.idx.jobs[4] && m.idx.jobs[4].state === 'error', 5000, 'agotó intentos');
    S.hooks.status = null; m.retryAll(); await settled(m, [4]); t('si se agotan los reintentos queda en error y «reintentar» lo recupera');

    S.hooks.stallAfter = 100 * 1024; m.enqueue([5]);
    await until(() => m.idx.jobs[5] && m.idx.jobs[5].tries >= 1, 4000, 'stall'); S.hooks.stallAfter = null;
    await settled(m, [5]); assert.ok((await readAll(m, 5)).equals(S.tracks[5].data)); t('conexión colgada (sin datos): se corta por inactividad, reintenta y retoma');
    await m.shutdown();
  }

  { // calidad
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v')), { cfg: { q: 'flac16' } }); await m.init();
    m.enqueue([11, 12]); await settled(m, [11, 12]);
    assert.strictEqual(m.idx.tracks[11].q, 'flac16'); assert.ok((await readAll(m, 11)).equals(S.tracks[11].alt));
    assert.strictEqual(m.idx.tracks[12].q, 'source'); assert.ok((await readAll(m, 12)).equals(S.tracks[12].data));
    t('calidad por defecto: flac16 en el hi-res; en el que no lo ofrece cae a source (sin error)');
    assert.deepStrictEqual(m.enqueue([11]), { added: 0, skipped: 1 });
    m.cfg.q = 'mp3_320'; m.enqueue([{ id: 12, q: 'mp3_320' }]); await until(() => m.idx.tracks[12].q === 'mp3_320', 5000, 'recalidad');
    // audio 11 + audio 12 nuevo + letra 12 nueva + carátula del álbum = 4 (los viejos de 12 ya no están)
    await until(() => fs.readdirSync(dir).filter((n) => /^[0-9a-f]{32}$/.test(n)).length === 4, 3000, 'borrado del archivo viejo').catch((e) => {
      throw new Error(e.message + ' | archivos=' + fs.readdirSync(dir).join() + ' | tracks=' + JSON.stringify(Object.values(m.idx.tracks).map((x) => [x.id, x.q, x.file, x.lyr && x.lyr.file])) + ' covers=' + JSON.stringify(m.idx.covers) + ' jobs=' + JSON.stringify(m.idx.jobs));
    });
    t('pedir otra calidad reemplaza la anterior y borra el archivo viejo');
    const est = await m.estimate([1, 2, 3], 'source');
    assert.strictEqual(est.count, 3); assert.strictEqual(est.bytes, Math.round(900 * 1000 / 8 * 200) * 3); assert.strictEqual(est.enough, true);
    const m2 = mkManager(S, tmp(), plainVault(tmp()), { opts: { statfs: async () => ({ bavail: 1000, bsize: 4096 }) } });
    assert.strictEqual((await m2.estimate([1], 'source')).enough, false); t('estimación de tamaño y espacio libre');
    await m.shutdown();
  }

  { // disco lleno
    const dir = tmp(), m = mkManager(S, dir, plainVault(path.join(dir, 'v')), { opts: { statfs: async () => ({ bavail: 100, bsize: 4096 }) } }); await m.init();
    m.enqueue([1]); await until(() => m.idx.jobs[1] && m.idx.jobs[1].state === 'error', 3000, 'disco');
    assert.match(m.idx.jobs[1].error, /espacio/); t('sin espacio en disco: error claro antes de escribir'); await m.shutdown();
  }

  { // clave perdida / huérfanos
    const dir = tmp(), vdir = path.join(dir, 'v'); let m = mkManager(S, path.join(dir, 'd'), plainVault(vdir)); await m.init();
    m.enqueue([1]); await settled(m, [1]); await m.shutdown();
    fs.writeFileSync(path.join(dir, 'd', 'a'.repeat(32)), 'huérfano'); fs.writeFileSync(path.join(dir, 'd', 'nota.txt'), 'mío');
    m = mkManager(S, path.join(dir, 'd'), plainVault(vdir)); await m.init();
    assert.ok(!fs.existsSync(path.join(dir, 'd', 'a'.repeat(32)))); assert.ok(fs.existsSync(path.join(dir, 'd', 'nota.txt'))); await m.shutdown();
    t('al arrancar borra archivos huérfanos con nombre de descarga y no toca archivos ajenos');
    fs.rmSync(vdir, { recursive: true }); // se perdió la clave
    m = mkManager(S, path.join(dir, 'd'), plainVault(vdir)); await m.init();
    assert.ok(!m.ready && /dañado|otra clave/.test(m.fatal)); assert.deepStrictEqual(m.enqueue([2]).added, 0);
    await m.resetStorage(); assert.ok(m.ready && !m.fatal); m.enqueue([2]); await settled(m, [2]);
    assert.ok((await readAll(m, 2)).equals(S.tracks[2].data)); assert.ok(!m.has(1));
    t('clave perdida: no inventa nada, avisa, y «borrar y empezar de cero» deja todo funcionando'); await m.shutdown();
  }

  S.server.close();
  console.log(`\n${ok} pruebas OK`);
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
