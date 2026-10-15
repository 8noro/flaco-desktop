'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  url: 'https://music.oron8.com',
  presence: 'auto',        // auto | on | off
  discordAppId: '',
  closeToTray: true,
  startMinimized: false,
  dlQuality: 'source',     // calidad por defecto de las descargas: source | flac16 | mp3_320 | ...
  dlConcurrency: 2,        // descargas simultáneas (1 a 4)
  maximized: false,
  bounds: { width: 1280, height: 800 },
};

// Si ya tenias instalada la presencia independiente, se reutiliza su URL y su Application ID (la API key NO se toca).
function readPresenceEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), 'flaco-presence', '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^(FLACO_URL|DISCORD_APP_ID)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no esta instalada */ }
  return out;
}

class Config {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.data = this._load();
  }

  _load() {
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* primera vez */ }
    const cfg = Object.assign({}, DEFAULTS, saved || {});
    if (!saved) {
      const env = readPresenceEnv();
      if (/^https?:\/\//i.test(env.FLACO_URL || '')) cfg.url = env.FLACO_URL.replace(/\/+$/, '');
      if (/^\d{5,25}$/.test(env.DISCORD_APP_ID || '')) cfg.discordAppId = env.DISCORD_APP_ID;
    }
    return cfg;
  }

  get() { return this.data; }

  set(patch) {
    Object.assign(this.data, patch);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('No pude guardar la configuracion:', e.message); }
  }
}

module.exports = { Config, DEFAULTS };
