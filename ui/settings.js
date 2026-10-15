'use strict';
const $ = (id) => document.getElementById(id);
let loaded = false;

function paint(snap) {
  if (!snap) return;
  const c = snap.cfg;
  if (!loaded) {
    $('url').value = c.url; $('presence').value = c.presence; $('app').value = c.discordAppId || '';
    $('tray').checked = !!c.closeToTray; $('min').checked = !!c.startMinimized;
    $('dlq').value = c.dlQuality || 'source'; $('dlc').value = String(c.dlConcurrency || 2);
    loaded = true;
  }
  $('ver').textContent = 'v' + snap.version;
  paintStatus(snap.presence);
  paintDl(snap.dl);
}

const mb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB');
const STATE = { queued: 'en cola', downloading: 'bajando', paused: 'en pausa', error: 'error' };
let lastDl = null;
function paintDl(d) {
  lastDl = d;
  if (!d) { $('dlst').textContent = 'Descargas no disponibles'; $('dldot').className = 'dot'; return; }
  const c = d.counts;
  let txt;
  if (d.fatal) txt = d.fatal;
  else if (!d.ready) txt = 'Iniciando…';
  else if (d.authBlocked) txt = 'Hace falta iniciar sesión en la ventana principal; la cola espera (pulsa «Reanudar» después).';
  else txt = `${c.downloaded} descargados (${mb(d.bytes)}) · ${c.queued} en cola${c.errors ? ' · ' + c.errors + ' con error' : ''}${d.paused ? ' · en pausa' : ''}`;
  $('dlst').textContent = txt;
  $('dldot').className = 'dot ' + (d.fatal || c.errors ? 'warn' : c.queued && !d.paused ? 'ok' : '');
  $('dlstore').textContent = d.storage
    ? (d.storage.protected ? `Clave protegida por el llavero del sistema (${d.storage.backend}).`
      : 'Aviso: no hay llavero del sistema disponible; la clave queda en un archivo de tu carpeta de datos (solo tu usuario puede leerlo).')
    : '';
  $('dlpause').textContent = d.paused || d.authBlocked ? 'Reanudar' : 'Pausar';
  $('dlpause').disabled = !!d.fatal; $('dlretry').disabled = !c.errors;
  const box = $('dljobs');
  box.textContent = '';
  for (const j of d.jobs) {
    const row = document.createElement('div'); row.className = 'job';
    const t = document.createElement('span'); t.className = 't';
    t.textContent = `${j.title || 'Tema ' + j.id} · ${STATE[j.state] || j.state}${j.state === 'downloading' ? ' ' + j.pct + '%' : ''}${j.error ? ' — ' + j.error : ''}`;
    row.append(t);
    if (j.state === 'downloading') { const pr = document.createElement('progress'); pr.max = 100; pr.value = j.pct; row.append(pr); }
    for (const [act, label, title] of [['prioritize', '↑', 'Subir al frente'], ['cancel', '✕', 'Cancelar']]) {
      const b = document.createElement('button'); b.className = 'sm'; b.textContent = label; b.title = title; b.dataset.act = act; b.dataset.id = j.id; row.append(b);
    }
    box.append(row);
  }
}
async function dlDo(act, arg) {
  const r = await window.flacoCfg.dl(act, arg);
  const m = $('msg');
  if (r && r.error) { m.className = 'err'; m.textContent = r.error; } else if (r && act === 'enqueue') { m.className = 'ok'; m.textContent = `En cola: ${r.added} · ya estaban: ${r.skipped}`; setTimeout(() => { m.textContent = ''; }, 3000); }
  refresh();
  return r;
}
$('dljobs').onclick = (e) => { const b = e.target.closest('button[data-act]'); if (b) dlDo(b.dataset.act, Number(b.dataset.id)); };
$('dlpause').onclick = () => dlDo(lastDl && (lastDl.paused || lastDl.authBlocked) ? 'resumeAll' : 'pauseAll');
$('dlretry').onclick = () => dlDo('retryAll');
$('dlclear').onclick = () => { if (confirm('¿Borrar todas las descargas y vaciar la cola? Los temas tendrán que bajarse de nuevo.')) dlDo(lastDl && lastDl.fatal ? 'reset' : 'clearAll'); };
$('dlgo').onclick = async () => {
  const ids = $('dlids').value.split(/[^0-9]+/).filter(Boolean).map(Number);
  if (ids.length) { const r = await dlDo('enqueue', { ids }); if (r && r.ok) $('dlids').value = ''; }
};
function paintStatus(p) {
  $('pst').textContent = p.text;
  $('dot').className = 'dot ' + (p.code === 'playing' ? 'ok' : (p.code === 'waiting' || p.code === 'noid') ? 'warn' : '');
}
async function refresh() { const s = await window.flacoCfg.get(); if (s) { if (loaded) { paintStatus(s.presence); paintDl(s.dl); } else paint(s); } }

$('save').onclick = async () => {
  const m = $('msg'); m.className = ''; m.textContent = '';
  const r = await window.flacoCfg.set({
    url: $('url').value, presence: $('presence').value, discordAppId: $('app').value,
    closeToTray: $('tray').checked, startMinimized: $('min').checked,
    dlQuality: $('dlq').value, dlConcurrency: Number($('dlc').value),
  });
  if (r && r.error) { m.className = 'err'; m.textContent = r.error; return; }
  m.className = 'ok'; m.textContent = 'Guardado';
  if (r.state) { paintStatus(r.state.presence); paintDl(r.state.dl); }
  setTimeout(() => { m.textContent = ''; }, 2500);
};
$('close').onclick = () => window.close();
refresh();
setInterval(refresh, 2000);
