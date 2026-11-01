'use strict';
// Sincronización con el servidor cuando vuelve la conexión (tanda 3):
//  · reproducciones hechas en la pantalla sin conexión → /api/played (con la hora real en que sonaron: cuentan en historial, stats y Wrapped)
//    y las VISTAS de cada tema → /api/view/<id> ya agrupadas ({n, off:true}); el servidor no les aplica el anti-repetición por IP, que
//    haría perder casi todas al llegar juntas.
//  · «mantener descargado» → baja lo nuevo de álbumes/playlists marcados (dl.syncKeep)
// Usa la sesión de la ventana (cookies de tu cuenta), igual que las descargas: no hace falta API key.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cuenta las reproducciones pendientes. Solo manda las de la cuenta con la que se abrió la web (o las que no tenían cuenta anotada);
// las de otra cuenta esperan. Se frena ante 401/403 (sin sesión), 429, 5xx o cortes de red; lo que no llegó se reintenta después
// (reenviar una reproducción es inofensivo: el servidor ignora la que ya tiene con esa misma hora).
async function syncPlays(dl, { fetch, base, me, gap = 250, log = () => {} }) {
  if (!dl || !dl.ready || !me) return { sent: 0, left: dl ? dl.playsPending().length : 0, stopped: !me ? 'sin sesión' : 'no listo' };
  const root = String(base).replace(/\/+$/, '');
  const todo = dl.playsPending().filter((p) => !p.u || p.u === me);
  const sent = [];
  let stopped = '';
  const post = (path, body) => fetch(root + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'include' });
  const transient = (r) => (r.status === 401 || r.status === 403) ? 'sin sesión' : (r.status === 429 || r.status >= 500) ? 'servidor ocupado (' + r.status + ')' : '';
  for (const p of todo) {
    let r;
    try { r = await post('/api/played', { track: p.id, sec: p.sec, ts: p.ts }); } catch (e) { stopped = 'sin red'; break; }
    stopped = transient(r);
    if (stopped) break;
    // 404/400: el tema ya no existe o el pedido no vale: no tiene sentido reintentar, se descarta.
    sent.push(p);
    if (gap) await sleep(gap);
  }
  // Vistas: una sola llamada por tema con la cantidad. Si falla, esas reproducciones quedan pendientes (no se pierde ninguna vista).
  const byTrack = new Map();
  for (const p of sent) if (p.v) { if (!byTrack.has(p.id)) byTrack.set(p.id, []); byTrack.get(p.id).push(p); }
  const hold = new Set();
  let cut = false;
  for (const [id, list] of byTrack) {
    if (cut) { list.forEach((p) => hold.add(p)); continue; }          // tras un corte, el resto de los temas con vistas espera
    let r, t = '';
    try { r = await post(`/api/view/${id}`, { n: list.length, off: true }); t = transient(r); } catch (e) { t = 'sin red'; }
    if (t) { stopped = stopped || t; cut = true; list.forEach((p) => hold.add(p)); }
  }
  const done = sent.filter((p) => !hold.has(p));
  if (done.length) dl.ackPlays(done);
  if (stopped) log('reproducciones offline: pausado, ' + stopped);
  return { sent: done.length, left: dl.playsPending().length, stopped };
}

module.exports = { syncPlays };
