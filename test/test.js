'use strict';
// Pruebas sin Electron: Discord falso por socket unix + PresenceManager con lectura simulada + script de la página.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { DiscordRPC, encode, OP } = require('../discord-rpc');
const { PresenceManager, pad } = require('../presence');
const { READ_JS } = require('../page-state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeDiscord(dir, { rejectId } = {}) {
  const frames = [];
  let pingReply = null;
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString());
        buf = buf.subarray(8 + len);
        if (op === OP.HANDSHAKE) {
          if (msg.client_id === rejectId) { sock.write(encode(OP.CLOSE, { code: 4000, message: 'Invalid Client ID' })); sock.end(); continue; }
          sock.write(encode(OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, user: { username: 'tester' } } }));
          sock.write(encode(OP.PING, { n: 7 }));
        } else if (op === OP.PONG) { pingReply = msg;
        } else if (op === OP.FRAME) {
          frames.push(msg);
          sock.write(encode(OP.FRAME, { cmd: msg.cmd, evt: null, data: {}, nonce: msg.nonce }));
        }
      }
    });
  });
  const p = path.join(dir, 'discord-ipc-0');
  return new Promise((res) => server.listen(p, () => res({ server, frames, path: p, pong: () => pingReply })));
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaco-test-'));
  let ok = 0;
  const t = (name) => { ok++; console.log('  ✔', name); };

  // 1) protocolo
  const fd = await fakeDiscord(dir);
  const rpc = new DiscordRPC('123456789012345678', { paths: [path.join(dir, 'nope-0'), fd.path] });
  const used = await rpc.connect(1500);
  assert.strictEqual(used, fd.path); assert.ok(rpc.ready); t('handshake + READY (salta rutas que no existen)');
  await sleep(50); assert.deepStrictEqual(fd.pong(), { n: 7 }); t('responde PING con PONG');
  await rpc.setActivity({ type: 2, details: 'Tema', state: 'Artista' });
  assert.strictEqual(fd.frames[0].cmd, 'SET_ACTIVITY'); assert.strictEqual(fd.frames[0].args.activity.type, 2);
  assert.ok(Number.isInteger(fd.frames[0].args.pid)); t('SET_ACTIVITY con type 2 (Listening) y pid');
  await rpc.clearActivity(); assert.strictEqual(fd.frames[1].args.activity, null); t('clearActivity manda activity:null');
  rpc.close(); fd.server.close();

  // 2) client id rechazado
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flaco-test-'));
  const bad = await fakeDiscord(dir2, { rejectId: '999999' });
  await assert.rejects(new DiscordRPC('999999', { paths: [bad.path] }).connect(1500), /Invalid Client ID/);
  bad.server.close(); t('Application ID inválido -> error claro');

  // 3) PresenceManager (RPC simulado)
  const calls = [];
  const mkRpc = () => {
    const e = new (require('events'))();
    e.ready = false;
    e.connect = async () => { e.ready = true; calls.push('connect'); };
    e.setActivity = async (a) => { calls.push(['set', a]); };
    e.clearActivity = async () => { calls.push('clear'); };
    e.close = () => { e.ready = false; calls.push('close'); };
    return e;
  };
  let state = null, ext = null, now = 1_000_000_000_000;
  const cfg = { presence: 'auto', discordAppId: '123456789012345678', url: 'https://music.oron8.com' };
  const pm = new PresenceManager({ getConfig: () => cfg, readState: async () => state, detect: async () => ext, createRpc: mkRpc, now: () => now, interval: 1e9 });
  const song = { id: 5, title: 'Canción', artist: 'Charly García', album: 'Clics Modernos', album_id: 9, dur: 240, pos: 30, playing: true, share: true };

  state = { ...song, at: now };
  await pm.tick();
  const set = calls.find((c) => Array.isArray(c))[1];
  assert.strictEqual(set.type, 2); assert.strictEqual(set.details, 'Canción'); assert.strictEqual(set.state, 'Charly García');
  assert.strictEqual(set.timestamps.start, now / 1000 - 30); assert.strictEqual(set.timestamps.end, now / 1000 - 30 + 240);
  assert.strictEqual(set.assets.large_image, 'https://music.oron8.com/api/cover/album/9?s=512');
  assert.strictEqual(pm.getStatus().code, 'playing'); t('sonando -> actividad con tiempos, carátula y estado');

  calls.length = 0; await pm.tick();
  assert.strictEqual(calls.length, 0); t('sin cambios no vuelve a mandar nada');

  now += 5000; state = { ...song, pos: 35, at: now }; await pm.tick();
  assert.strictEqual(calls.length, 0); t('el avance normal del tiempo no cuenta como cambio');

  state = { ...song, pos: 120, at: now }; await pm.tick();
  assert.strictEqual(calls.filter((c) => Array.isArray(c)).length, 1); t('un seek actualiza el tiempo');

  calls.length = 0; state = { ...song, playing: false, at: now }; await pm.tick();
  assert.deepStrictEqual(calls, ['clear']); t('pausa -> limpia la presencia');

  calls.length = 0; state = { ...song, id: 6, share: false, at: now }; await pm.tick();
  assert.ok(!calls.some((c) => Array.isArray(c))); t('«Mostrar lo que escucho» apagado -> no se publica');

  calls.length = 0; state = { ...song, id: 7, at: now }; ext = 'servicio flaco-presence'; pm.extAt = 0; await pm.tick();
  assert.ok(calls.includes('clear') && calls.includes('close')); assert.strictEqual(pm.getStatus().code, 'external');
  assert.ok(!calls.some((c) => Array.isArray(c))); t('auto + presencia del sistema detectada -> el cliente se retira y no duplica');

  calls.length = 0; cfg.presence = 'on'; await pm.tick();
  assert.ok(calls.some((c) => Array.isArray(c))); t('modo «siempre» ignora la detección');

  calls.length = 0; ext = null; cfg.presence = 'auto'; cfg.discordAppId = ''; pm.extAt = 0; await pm.tick();
  assert.strictEqual(pm.getStatus().code, 'noid'); t('sin Application ID avisa en vez de fallar');

  cfg.discordAppId = '123456789012345678'; cfg.presence = 'off'; calls.length = 0; await pm.tick();
  assert.strictEqual(pm.getStatus().code, 'off'); assert.ok(!calls.some((c) => Array.isArray(c))); t('modo apagado');

  cfg.presence = 'auto'; cfg.url = 'http://192.168.0.3:8080'; state = { ...song, id: 8, at: now }; calls.length = 0; await pm.tick();
  assert.strictEqual(calls.find((c) => Array.isArray(c))[1].assets, undefined); t('URL http local -> sin carátula (Discord no podría bajarla)');

  assert.strictEqual(pad(''), '— '); assert.strictEqual(pad('a'), 'a '); assert.strictEqual(pad('x'.repeat(300)).length, 128); t('pad() cumple los mínimos/máximos de Discord');

  // 4) script que se evalúa en la página, con S/A simulados como en la UI real
  const mk = (extra = {}) => vm.runInNewContext(READ_JS, Object.assign({ isFinite }, extra));
  const A = () => ({ duration: 200, currentTime: 12.5, paused: false, src: 'x' });
  const r = mk({ S: { cur: { id: 3, title: 'T', artist: 'Ar', album: 'Al', album_id: 4, dur: 199 }, me: { share_now: false } }, A });
  assert.deepStrictEqual({ ...r }, { id: 3, title: 'T', artist: 'Ar', album: 'Al', album_id: 4, dur: 200, pos: 12.5, playing: true, share: false });
  assert.strictEqual(mk({}), null);
  assert.strictEqual(mk({ S: { cur: null, me: null }, A: () => ({ paused: true, src: '', currentTime: 0, duration: NaN }) }).id, 0);
  t('lectura del estado de la página (con y sin tema, con y sin cuenta)');

  console.log(`\n${ok} pruebas OK`);
  process.exit(0);
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
