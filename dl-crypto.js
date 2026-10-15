'use strict';
// Cifrado de las descargas de FLACo! Desktop (sin dependencias de npm; solo `crypto` y `fs`).
//
// Archivo de audio cifrado ("FLC1"), por bloques para poder hacer seek sin descifrar todo:
//   cabecera (36 bytes, en claro): "FLC1" | versión(1) | 0 0 0 | tamaño de bloque u32 | tamaño del audio u64 | sal(16)
//   luego, por cada bloque de 256 KiB de audio: texto cifrado + etiqueta GCM de 16 bytes (el último puede ser más corto).
//   Clave de cada archivo = HKDF-SHA256(clave maestra, sal propia del archivo). Nonce = nº de bloque (clave única por archivo).
//   AAD = cabecera + nº de bloque: cambiar el orden, quitar o mover bloques, o tocar la cabecera, hace fallar la autenticación.
//   El tamaño total está en la cabecera: un archivo truncado se detecta al abrirlo.
// Blobs chicos (índice, carátula, letra): nonce(12) | texto cifrado | etiqueta(16), con AAD = etiqueta de uso.
//
// La clave maestra la guarda KeyVault: protegida con el llavero del sistema (safeStorage de Electron: KWallet/libsecret/
// Keychain/DPAPI) si existe; si no hay llavero queda en un archivo con permisos 0600 y se avisa (protected=false).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const CHUNK = 256 * 1024;
const TAG = 16;
const HDR = 36;
const MAGIC = Buffer.from('FLC1');
const VER = 1;

const hkdf = (master, salt, info) => Buffer.from(crypto.hkdfSync('sha256', master, salt, info, 32));
const nonceFor = (i) => { const n = Buffer.alloc(12); n.writeUInt32BE(i >>> 0, 8); return n; };
const aadFor = (header, i) => { const a = Buffer.alloc(HDR + 4); header.copy(a); a.writeUInt32BE(i >>> 0, HDR); return a; };

function makeHeader(total, salt, chunk = CHUNK) {
  const h = Buffer.alloc(HDR);
  MAGIC.copy(h, 0); h[4] = VER; h.writeUInt32BE(chunk, 8); h.writeBigUInt64BE(BigInt(total), 12); salt.copy(h, 20);
  return h;
}

function parseHeader(h) {
  if (h.length < HDR || !h.subarray(0, 4).equals(MAGIC)) throw new Error('No es un archivo de descarga de FLACo!');
  if (h[4] !== VER) throw new Error('Versión de archivo no soportada');
  const chunk = h.readUInt32BE(8);
  if (chunk !== CHUNK) throw new Error('Tamaño de bloque inválido');
  const total = Number(h.readBigUInt64BE(12));
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Tamaño inválido');
  return { chunk, total, salt: h.subarray(20, 36) };
}

function encChunk(key, header, i, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(i), { authTagLength: TAG });
  c.setAAD(aadFor(header, i));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function decChunk(key, header, i, rec) {
  if (rec.length < TAG) throw new Error('Bloque corrupto');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(i), { authTagLength: TAG });
  d.setAAD(aadFor(header, i));
  d.setAuthTag(rec.subarray(rec.length - TAG));
  return Buffer.concat([d.update(rec.subarray(0, rec.length - TAG)), d.final()]);
}

const nChunks = (total) => Math.ceil(total / CHUNK);
const fileSize = (total) => HDR + total + nChunks(total) * TAG;

async function readAt(fh, len, pos) {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === len ? b : b.subarray(0, got);
}

// ---- escritura (secuencial, con reanudación) ----
class EncWriter {
  constructor(fh, header, key, total, index, pos) {
    this.fh = fh; this.header = header; this.key = key; this.total = total;
    this.index = index; this.pos = pos; this.buf = Buffer.alloc(0); this.done = false;
  }

  static async create(file, master, total) {
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Tamaño inválido');
    const salt = crypto.randomBytes(16);
    const header = makeHeader(total, salt);
    const fh = await fsp.open(file, 'wx', 0o600);
    try { await fh.write(header, 0, HDR, 0); } catch (e) { await fh.close(); throw e; }
    return new EncWriter(fh, header, hkdf(master, salt, 'flaco-dl-file-v1'), total, 0, HDR);
  }

  // Reabre un .part: conserva solo los bloques completos y verifica que el último descifre (por si se cortó la luz a mitad de escritura).
  static async resume(file, master) {
    const fh = await fsp.open(file, 'r+');
    try {
      const header = await readAt(fh, HDR, 0);
      const { total, salt } = parseHeader(header);
      const key = hkdf(master, salt, 'flaco-dl-file-v1');
      const size = (await fh.stat()).size;
      let n = Math.min(Math.floor(Math.max(0, size - HDR) / (CHUNK + TAG)), Math.floor(total / CHUNK));
      while (n > 0) {
        try {
          const rec = await readAt(fh, CHUNK + TAG, HDR + (n - 1) * (CHUNK + TAG));
          decChunk(key, header, n - 1, rec);
          break;
        } catch { n--; }
      }
      const pos = HDR + n * (CHUNK + TAG);
      await fh.truncate(pos);
      return new EncWriter(fh, header, key, total, n, pos);
    } catch (e) { await fh.close().catch(() => {}); throw e; }
  }

  get offset() { return this.index * CHUNK + this.buf.length; } // bytes de audio aceptados hasta ahora
  get chunksOffset() { return this.index * CHUNK; }              // bytes ya seguros en disco

  async _put(plain) {
    const rec = encChunk(this.key, this.header, this.index, plain);
    await this.fh.write(rec, 0, rec.length, this.pos);
    this.pos += rec.length;
    this.index++;
  }

  async write(data) {
    if (this.done) throw new Error('Archivo ya cerrado');
    if (this.offset + data.length > this.total) throw new Error('El servidor mandó más bytes de los anunciados');
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    while (this.buf.length >= CHUNK) {
      const piece = this.buf.subarray(0, CHUNK);
      this.buf = this.buf.subarray(CHUNK);
      await this._put(piece);
    }
  }

  async finish() {
    if (this.done) return;
    if (this.buf.length) { const rest = this.buf; this.buf = Buffer.alloc(0); await this._put(rest); }
    if (this.index !== nChunks(this.total)) throw new Error('Faltan bytes: la descarga quedó incompleta');
    const st = await this.fh.stat();
    if (st.size !== fileSize(this.total)) throw new Error('Tamaño final inesperado');
    await this.fh.sync();
    this.done = true;
    await this.fh.close();
  }

  async close() { // cierra sin terminar (se conserva lo escrito para reanudar)
    if (this.done) return;
    this.done = true;
    await this.fh.close().catch(() => {});
  }
}

// ---- lectura con acceso aleatorio (para el protocolo de reproducción de la tanda 2) ----
class EncReader {
  constructor(fh, header, key, total) {
    this.fh = fh; this.header = header; this.key = key; this.size = total;
    this.cache = new Map();
  }

  static async open(file, master) {
    const fh = await fsp.open(file, 'r');
    try {
      const header = await readAt(fh, HDR, 0);
      const { total, salt } = parseHeader(header);
      const st = await fh.stat();
      if (st.size !== fileSize(total)) throw new Error('Archivo incompleto o alterado');
      return new EncReader(fh, header, hkdf(master, salt, 'flaco-dl-file-v1'), total);
    } catch (e) { await fh.close().catch(() => {}); throw e; }
  }

  async _chunk(i) {
    const hit = this.cache.get(i);
    if (hit) { this.cache.delete(i); this.cache.set(i, hit); return hit; }
    const last = nChunks(this.size) - 1;
    const plainLen = i === last ? this.size - last * CHUNK : CHUNK;
    const rec = await readAt(this.fh, plainLen + TAG, HDR + i * (CHUNK + TAG));
    const pt = decChunk(this.key, this.header, i, rec);
    this.cache.set(i, pt);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return pt;
  }

  // Bytes [start, end] inclusive del audio original.
  async read(start, end) {
    if (this.size === 0) return Buffer.alloc(0);
    start = Math.max(0, start); end = Math.min(this.size - 1, end);
    if (end < start) return Buffer.alloc(0);
    const out = [];
    for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK); i++) {
      const pt = await this._chunk(i);
      const a = i * CHUNK;
      out.push(pt.subarray(Math.max(0, start - a), Math.min(pt.length, end - a + 1)));
    }
    return Buffer.concat(out);
  }

  async close() { this.cache.clear(); await this.fh.close().catch(() => {}); }
}

// ---- blobs chicos ----
function sealBlob(master, info, plain) {
  const key = hkdf(master, Buffer.alloc(0), 'flaco-blob-v1:' + info);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG });
  c.setAAD(Buffer.from(info));
  return Buffer.concat([nonce, c.update(plain), c.final(), c.getAuthTag()]);
}

function openBlob(master, info, blob) {
  if (blob.length < 12 + TAG) throw new Error('Blob corrupto');
  const key = hkdf(master, Buffer.alloc(0), 'flaco-blob-v1:' + info);
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: TAG });
  d.setAAD(Buffer.from(info));
  d.setAuthTag(blob.subarray(blob.length - TAG));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - TAG)), d.final()]);
}

// ---- clave maestra ----
class KeyLostError extends Error {}

class KeyVault {
  // safeStorage: el de Electron (o un doble en las pruebas). Sin él, o sin llavero real, la clave va a un archivo 0600.
  constructor({ dir, safeStorage = null, log = () => {} }) {
    this.file = path.join(dir, 'master.key');
    this.dir = dir; this.ss = safeStorage; this.log = log;
    this.key = null; this.mode = null;
  }

  _backend() {
    try {
      if (!this.ss || !this.ss.isEncryptionAvailable()) return null;
      const b = typeof this.ss.getSelectedStorageBackend === 'function' ? this.ss.getSelectedStorageBackend() : 'os';
      return b === 'basic_text' ? null : b; // basic_text = sin llavero: Electron "cifra" con una clave fija, no sirve
    } catch { return null; }
  }

  get status() {
    return { protected: this.mode === 'safe', backend: this.mode === 'safe' ? (this._backend() || 'os') : 'archivo' };
  }

  load() {
    if (this.key) return this.key;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* primera vez */ }
    if (saved && saved.data) {
      let raw;
      if (saved.mode === 'safe') {
        try { raw = Buffer.from(this.ss.decryptString(Buffer.from(saved.data, 'base64')), 'base64'); } catch {
          throw new KeyLostError('No pude recuperar la clave del llavero del sistema (¿cambió el llavero o el usuario?). Las descargas existentes no se pueden leer.');
        }
      } else raw = Buffer.from(saved.data, 'base64');
      if (raw.length !== 32) throw new KeyLostError('La clave guardada está dañada.');
      this.key = raw; this.mode = saved.mode === 'safe' ? 'safe' : 'plain';
      // Si ahora hay llavero y la clave estaba en archivo, se sube al llavero.
      if (this.mode === 'plain' && this._backend()) this._store(raw);
      return this.key;
    }
    this._store(crypto.randomBytes(32));
    return this.key;
  }

  _store(key) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let rec;
    if (this._backend()) {
      try { rec = { v: 1, mode: 'safe', data: this.ss.encryptString(key.toString('base64')).toString('base64') }; } catch (e) { this.log('llavero:', e.message); }
    }
    if (!rec) rec = { v: 1, mode: 'plain', data: key.toString('base64') };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.key = key; this.mode = rec.mode;
  }

  reset() { // borra la clave: todo lo cifrado con ella queda inservible
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignorar */ }
    this.key = null; this.mode = null;
    return this.load();
  }
}

module.exports = { EncWriter, EncReader, sealBlob, openBlob, KeyVault, KeyLostError, CHUNK, TAG, HDR, fileSize };
