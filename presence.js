'use strict';
// Discord Rich Presence de FLACo! ("Escuchando X en FLACo!").
// Lee lo que suena directamente de la pagina (sin API key) y lo publica en Discord.
// Modo "auto": si en el sistema ya corre la presencia independiente (servicio flaco-presence), el cliente NO la duplica.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { DiscordRPC } = require('./discord-rpc');

const pad = (s, n = 2) => {
  s = String(s == null ? '' : s).trim() || '—';
  if (s.length < n) s += ' ';
  return s.slice(0, 128);
};

function run(cmd, args) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout: 3000 }, (err, out) => res({ ok: !err, out: String(out || '').trim() }));
  });
}

// ¿Hay otra presencia de FLACo! corriendo en este sistema? (la de instalar-presencia.sh)
async function detectExternal() {
  if (process.platform !== 'linux') return null;
  const s = await run('systemctl', ['--user', 'is-active', 'flaco-presence']);
  if (['active', 'activating', 'reloading'].includes(s.out)) return 'servicio flaco-presence';
  const p = await run('pgrep', ['-f', 'flaco-presence/presence.py']);
  if (p.ok && p.out) return 'presence.py en ejecución';
  return null;
}

class PresenceManager extends EventEmitter {
  constructor({ getConfig, readState, detect = detectExternal, createRpc = (id) => new DiscordRPC(id), interval = 3000, now = () => Date.now(), log = () => {} }) {
    super();
    Object.assign(this, { getConfig, readState, detect, createRpc, interval, now, log });
    this.rpc = null;
    this.appId = null;
    this.last = null;
    this.busy = false;
    this.timer = null;
    this.ext = null;
    this.extAt = 0;
    this.status = { code: 'idle', text: 'Iniciando…' };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.interval);
    this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this._disconnect(true);
  }

  getStatus() { return this.status; }

  _set(code, text) {
    if (this.status.code === code && this.status.text === text) return;
    this.status = { code, text };
    this.emit('status', this.status);
  }

  async _external() {
    const t = this.now();
    if (t - this.extAt > 15000) {
      try { this.ext = await this.detect(); } catch { this.ext = null; }
      this.extAt = t;
    }
    return this.ext;
  }

  forceRecheck() { this.extAt = 0; this.tick(); }

  async _disconnect(clearFirst) {
    const rpc = this.rpc;
    this.rpc = null;
    this.last = null;
    if (!rpc) return;
    try { if (clearFirst && rpc.ready) await rpc.clearActivity(); } catch { /* ignorar */ }
    rpc.close();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await this._tick(); } catch (e) { this.log('presencia:', e.message); } finally { this.busy = false; }
  }

  async _tick() {
    const cfg = this.getConfig();
    if (cfg.presence === 'off') { await this._disconnect(true); return this._set('off', 'Desactivada'); }
    if (cfg.presence !== 'on') {
      const ext = await this._external();
      if (ext) { await this._disconnect(true); return this._set('external', `Ya la maneja el sistema (${ext}); el cliente no la duplica`); }
    }
    if (!/^\d{5,25}$/.test(String(cfg.discordAppId || ''))) {
      await this._disconnect(true);
      return this._set('noid', 'Falta el Application ID de Discord (Ajustes)');
    }
    if (this.rpc && this.appId !== cfg.discordAppId) await this._disconnect(true);

    const s = await this.readState();
    const playing = !!(s && s.playing && s.id && s.share !== false);
    if (!playing) {
      if (this.rpc && this.rpc.ready && this.last) { try { await this.rpc.clearActivity(); } catch { /* ignorar */ } }
      this.last = null;
      return this._set('idle', this.rpc && this.rpc.ready ? 'Conectada a Discord · nada sonando' : 'Lista · esperando una canción');
    }

    const t = (s.at || this.now()) / 1000;
    const dur = Number(s.dur) || 0;
    const start = t - (Number(s.pos) || 0);
    const end = dur ? start + dur : null;
    if (end && end < this.now() / 1000) { // el tema ya terminó
      if (this.rpc && this.rpc.ready && this.last) { try { await this.rpc.clearActivity(); } catch { /* ignorar */ } }
      this.last = null;
      return;
    }
    if (this.last && this.last.id === s.id && Math.abs(start - this.last.start) <= 3) return; // sin cambios

    if (!(await this._ensure(cfg.discordAppId))) return;
    try {
      await this.rpc.setActivity(this._activity(s, cfg, start, end));
      this.last = { id: s.id, start };
      this._set('playing', `Mostrando «${s.title}» en Discord`);
    } catch (e) {
      this.log('presencia: SET_ACTIVITY falló:', e.message);
      await this._disconnect(false);
      this._set('waiting', 'Discord no respondió; reintentando…');
    }
  }

  async _ensure(appId) {
    if (this.rpc && this.rpc.ready) return true;
    await this._disconnect(false);
    const rpc = this.createRpc(appId);
    rpc.on('close', () => { if (this.rpc === rpc) { this.rpc = null; this.last = null; } });
    try {
      await rpc.connect();
    } catch (e) {
      this._set('waiting', 'No encuentro Discord: abre la app de escritorio (reintento solo)');
      return false;
    }
    this.rpc = rpc;
    this.appId = appId;
    return true;
  }

  _activity(s, cfg, start, end) {
    const a = { type: 2, details: pad(s.title), state: pad(s.artist), timestamps: { start: Math.floor(start) } };
    if (end) a.timestamps.end = Math.floor(end);
    const base = String(cfg.url || '').replace(/\/+$/, '');
    // Discord baja la carátula desde su propio servidor: solo sirve con una URL https pública.
    if (/^https:\/\//i.test(base) && s.album_id) {
      a.assets = { large_image: `${base}/api/cover/album/${s.album_id}?s=512`, large_text: pad(s.album) };
    }
    return a;
  }
}

module.exports = { PresenceManager, detectExternal, pad };
