'use strict';
// Cliente minimo del IPC de Discord (sin dependencias): handshake + SET_ACTIVITY.
// Habla con la app de escritorio de Discord por un socket unix / named pipe (discord-ipc-N).
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Rutas donde Discord puede escuchar. Incluye Flatpak, Snap y Vesktop, asi no hace falta el symlink a mano.
function candidatePaths(env = process.env, platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push('\\\\?\\pipe\\discord-ipc-' + i);
    return out;
  }
  const bases = [];
  for (const d of [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp']) if (d && !bases.includes(d)) bases.push(d);
  const run = env.XDG_RUNTIME_DIR;
  const sub = ['app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary', 'app/dev.vencord.Vesktop', 'snap.discord', 'snap.discord-canary'];
  for (let i = 0; i < 10; i++) {
    for (const b of bases) out.push(path.join(b, 'discord-ipc-' + i));
    if (run) for (const s of sub) out.push(path.join(run, s, 'discord-ipc-' + i));
  }
  return out;
}

function encode(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

class DiscordRPC extends EventEmitter {
  constructor(clientId, opts = {}) {
    super();
    this.clientId = String(clientId);
    this.paths = opts.paths || candidatePaths();
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pending = new Map();
    this._hs = null;
  }

  async connect(timeout = 4000) {
    let lastErr = new Error('No encontre Discord (abre la app de escritorio)');
    for (const p of this.paths) {
      if (process.platform !== 'win32' && !fs.existsSync(p)) continue;
      try {
        await this._tryConnect(p, timeout);
        return p;
      } catch (e) {
        lastErr = e;
        this._teardown();
      }
    }
    throw lastErr;
  }

  _tryConnect(p, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = net.createConnection(p);
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._hs = null;
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => settle(new Error('Discord no respondio al saludo')), timeout);
      this._hs = settle;
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.on('connect', () => this._write(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { if (!settled) settle(e); else this._onClose(); });
      sock.on('close', () => { if (!settled) settle(new Error('Discord cerro la conexion')); else this._onClose(); });
    });
  }

  _write(op, obj) {
    if (this.sock && !this.sock.destroyed) this.sock.write(encode(op, obj));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > (1 << 24)) { this._teardown(); return; }
      if (this.buf.length < 8 + len) break;
      const raw = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let msg = {};
      try { msg = JSON.parse(raw); } catch { /* ignorar */ }
      this._handle(op, msg);
    }
  }

  _handle(op, msg) {
    if (op === OP.PING) return this._write(OP.PONG, msg);
    if (op === OP.CLOSE) {
      if (this._hs) this._hs(new Error('Discord rechazo la conexion: ' + (msg.message || msg.code || 'sin motivo')));
      return this._teardown();
    }
    if (op !== OP.FRAME) return;
    if (msg.evt === 'READY') {
      this.ready = true;
      if (this._hs) this._hs();
      return this.emit('ready', msg.data);
    }
    if (msg.nonce && this.pending.has(msg.nonce)) {
      const p = this.pending.get(msg.nonce);
      this.pending.delete(msg.nonce);
      clearTimeout(p.t);
      if (msg.evt === 'ERROR') p.rej(new Error((msg.data && msg.data.message) || 'Error de Discord'));
      else p.res(msg.data);
    }
  }

  request(cmd, args) {
    if (!this.ready) return Promise.reject(new Error('No conectado a Discord'));
    const nonce = crypto.randomUUID();
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(nonce); rej(new Error('Discord no respondio')); }, 5000);
      this.pending.set(nonce, { res, rej, t });
      this._write(OP.FRAME, { cmd, args, nonce });
    });
  }

  setActivity(activity) { return this.request('SET_ACTIVITY', { pid: process.pid, activity }); }
  clearActivity() { return this.request('SET_ACTIVITY', { pid: process.pid, activity: null }); }

  close() {
    try { if (this.sock && this.ready) this._write(OP.CLOSE, {}); } catch { /* ignorar */ }
    this._teardown();
  }

  _teardown() {
    const had = this.ready || !!this.sock;
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.t); p.rej(new Error('Conexion cerrada')); }
    this.pending.clear();
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignorar */ } this.sock = null; }
    if (had) this.emit('close');
  }

  _onClose() { this._teardown(); }
}

module.exports = { DiscordRPC, candidatePaths, encode, OP };
