'use strict';
// Pantalla «sin conexión» de FLACo! Desktop: la misma interfaz que la web (rail, tarjetas, filas, barra del reproductor y letra)
// pero con lo descargado, acento ámbar y una franja de estado. El audio lo descifra el cliente al vuelo (flaco-dl://).
// Lo que viene del servidor/tags pasa siempre por esc(): nada se interpreta como HTML. (La CSP no permite scripts ni estilos en línea.)
const IC = {home:"M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",search:"M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5",artists:"M12 4a4 4 0 100 8 4 4 0 000-8zM4 21c0-4.4 3.6-8 8-8s8 3.6 8 8",albums:"M12 3a9 9 0 100 18 9 9 0 000-18zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z",play:"F:M8 5v14l11-7z",pause:"F:M6 5h4v14H6zM14 5h4v14h-4z",next:"F:M6 18l8.5-6L6 6zM16 6h2v12h-2z",prev:"F:M18 6l-8.5 6 8.5 6zM6 6h2v12H6z",shuffle:"M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5",vol:"M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13",mute:"M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6",lyrics:"M4 5a1 1 0 011-1h14a1 1 0 011 1v10a1 1 0 01-1 1H9l-5 4zM8 8.5h8M8 12h5",queue:"M4 6h16M4 12h16M4 18h9",x:"M6 6l12 12M18 6L6 18",more:"M5 12h.01M12 12h.01M19 12h.01",refresh:"M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",sliders:"M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",wifioff:"M3 3l18 18M5 12.9a10 10 0 013.4-2.1M10 5.2A15 15 0 0122 8.8M8.5 16.4a5 5 0 017 0M12 20h.01",check:"M5 12.5l4.5 4.5L19 7.5",download:"M12 4v10M8 10l4 4 4-4M5 20h14",repeat:"M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"};
const ic = (n, c = '') => { const d = IC[n] || '', f = d.startsWith('F:'); return `<svg class="i ${c}" viewBox="0 0 24 24" ${f ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}><path d="${f ? d.slice(2) : d}"/></svg>`; };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qs = new URLSearchParams(location.search);
const server = qs.get('u') || '';
const why = (qs.get('e') || '').replace(/^net::/, '');
const manual = qs.get('m') === '1';
const theme = qs.get('th') || 'dark';
if (theme === 'light' || theme === 'midnight') document.body.classList.add('th-' + theme);

const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const dur = (s) => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`; };
const mb = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB');
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

// ---- estado global que leen la bandeja y las teclas multimedia del cliente (mismas formas que la web: S.cur, A(), toggle/next/prev) ----
const S = { cur: null, me: null };
const au = new Audio();
au.preload = 'auto';
function A() { return au; }

let st = { ready: false, fatal: '', plays: 0 }, lib = [], byId = new Map(), albums = new Map(), artists = new Map();
let queue = [], orig = [], qi = -1, shuffle = false, fails = 0, drag = false, shown = [], sq = '', back = false;

// ---- índices: álbumes y artistas a partir de lo descargado ----
const albKey = (t) => String(t.album_id || 'n:' + (t.album || ''));
const artKey = (t) => String(t.artist_id || 'n:' + (t.artist || ''));
const cmpTr = (a, b) => (a.disc || 1) - (b.disc || 1) || (a.no || 0) - (b.no || 0) || String(a.title).localeCompare(String(b.title), 'es');
function build() {
  byId = new Map(lib.map((t) => [t.id, t]));
  albums = new Map(); artists = new Map();
  for (const t of lib) {
    const ak = albKey(t), rk = artKey(t);
    if (!albums.has(ak)) albums.set(ak, { key: ak, id: t.album_id, name: t.album || 'Álbum desconocido', year: t.year, artist: t.artist || 'Artista desconocido', artistKey: rk, tracks: [] });
    albums.get(ak).tracks.push(t);
    if (!artists.has(rk)) artists.set(rk, { key: rk, name: t.artist || 'Artista desconocido', albums: new Map(), tracks: [] });
    const ar = artists.get(rk); ar.tracks.push(t);
    if (!ar.albums.has(ak)) ar.albums.set(ak, albums.get(ak));
  }
  for (const a of albums.values()) a.tracks.sort(cmpTr);
  for (const r of artists.values()) { r.albums = [...r.albums.values()].sort((a, b) => (a.year || 0) - (b.year || 0) || a.name.localeCompare(b.name, 'es')); r.cover = (r.albums.find((a) => a.id) || {}).id; }
}
const albList = () => [...albums.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));
const artList = () => [...artists.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'));

// ---- piezas de interfaz ----
const noCov = '<div class="nocov"></div>';
const cover = (id, cls = 'cov') => (id ? `<img class="${cls}" src="../cover/${id}" alt="" loading="lazy">` : noCov);
function qchip(t) {
  if (t.q && t.q !== 'source') return ['ns lossy', t.q.replace('_', ' ').toUpperCase()];
  const hi = (t.bits || 0) > 16 || (t.sr || 0) > 44100, std = String(t.codec).toUpperCase() === 'FLAC' && !hi;
  const label = [String(t.codec || '').toUpperCase(), t.bits && t.sr ? `${t.bits}/${+(t.sr / 1000).toFixed(1)}` : ''].filter(Boolean).join(' ');
  return [std ? '' : 'ns ' + (hi ? 'hires' : (t.tier || 'lossy')), label];
}
function row(t, i, sub) {
  const [qc, ql] = qchip(t);
  return `<div class="tr${S.cur && S.cur.id === t.id ? ' cur' : ''}" data-i="${i}" data-id="${t.id}" tabindex="0"><span class="ix"><b>${sub === 'n' ? (t.no || i + 1) : i + 1}</b><u>${ic('play')}</u><i class="eq"><s></s><s></s><s></s></i></span><span class="tt"><span class="t">${esc(t.title)}</span>${sub && sub !== 'n' ? `<span class="s">${esc(sub === 'artist' ? t.artist : t.album)}</span>` : ''}</span><span class="qcw"><em class="qc ${qc}">${esc(ql)}</em></span><span class="du">${mmss(t.dur)}</span></div>`;
}
const albumCard = (a) => `<a class="card" href="#/album/${encodeURIComponent(a.key)}"><div class="cv">${cover(a.id, '')}<button class="pl" data-pa="${esc(a.key)}" aria-label="Reproducir">${ic('play')}</button></div><div class="ct">${esc(a.name)}</div><div class="cs">${esc(a.artist)}${a.year ? ' · ' + esc(a.year) : ''}</div></a>`;
const artistCard = (r) => `<a class="card ar" href="#/artist/${encodeURIComponent(r.key)}"><div class="cv">${cover(r.cover, '')}<button class="pl" data-pr="${esc(r.key)}" aria-label="Reproducir">${ic('play')}</button></div><div class="ct">${esc(r.name)}</div><div class="cs">${plural(r.albums.length, 'álbum', 'álbumes')} · ${plural(r.tracks.length, 'tema', 'temas')}</div></a>`;
const acts = (extra = '') => `<div class="acts"><button class="pbtn" data-act="playall" aria-label="Reproducir">${ic('play')}</button><button class="ibtn" data-act="shufall" aria-label="Aleatorio" title="Aleatorio">${ic('shuffle')}</button>${extra}</div>`;
const rail = (on) => {
  const it = [['#/', 'home', 'Inicio'], ['#/search', 'search', 'Buscar'], ['#/artists', 'artists', 'Artistas'], ['#/albums', 'albums', 'Álbumes'], ['#/songs', 'queue', 'Canciones']];
  $('rail').innerHTML = `<div class="logo" title="FLACo! · sin conexión"><b>${ic('wifioff')}</b></div>` + it.map(([h, i, t]) => `<a class="rb${on === h ? ' on' : ''}" href="${h}" title="${t}" aria-label="${t}">${ic(i)}</a>`).join('') + `<span class="sp"></span><a class="rb" href="flaco-ajustes:" title="Ajustes del cliente" aria-label="Ajustes del cliente">${ic('sliders')}</a>`;
};

// ---- franja de estado ----
let conn = manual ? 'manual' : 'off'; // off | manual | back (volvió el servidor y hay música sonando)
function offbar() {
  const pend = st.plays ? `<span class="pn" title="Se cuentan en tu historial y en las vistas cuando vuelva la conexión">${plural(st.plays, 'reproducción', 'reproducciones')} por contar</span>` : '';
  let ico = 'wifioff', cls = '', t, sub, btns;
  if (conn === 'back') { ico = 'check'; cls = ' ok'; t = 'Volvió la conexión'; sub = 'Cuando termines, vuelve a FLACo! para seguir en línea. Tus reproducciones se cuentan solas en unos segundos.'; btns = `<a class="btn pri" href="${esc(server)}">Volver a FLACo!</a>`; }
  else if (conn === 'manual') { cls = ' man'; t = 'Modo sin conexión'; sub = 'Solo lo descargado. Lo que escuches se cuenta en tu cuenta igual.'; btns = server ? `<a class="btn pri" href="${esc(server)}">Volver a FLACo!</a>` : ''; }
  else { t = 'Sin conexión con el servidor'; sub = 'Escuchas lo que descargaste. Lo que reproduzcas se cuenta (historial, vistas y stats) apenas vuelva la conexión.' + (why ? ' · ' + why : ''); btns = `<button class="btn" id="retry">${ic('refresh', 'sm')} Reintentar</button>`; }
  $('offbar').innerHTML = `<div class="offb${cls}" role="status"><span class="oi">${ic(ico)}</span><div class="ot"><b>${t}</b><span>${esc(sub)}</span></div>${pend}${btns}</div>`;
}

// ---- vistas ----
function empty(icon, title, body, buttons) {
  return `<div class="empty"><div class="big">${ic(icon, 'lg')}</div><h1>${title}</h1>${body}<div class="acts">${buttons}</div></div>`;
}
const settingsBtn = '<a class="btn" href="flaco-ajustes:">Ajustes del cliente</a>';
function setList(ids) { shown = ids; }
function route() {
  const v = $('view'), h = location.hash || '#/', [, kind, rawArg] = h.split('?')[0].split('/'), arg = rawArg ? decodeURIComponent(rawArg) : '';
  v.scrollTop = 0; $('main').scrollTop = 0;
  if (st.fatal) { rail(''); v.innerHTML = empty('wifioff', 'Problema con las descargas', `<p>${esc(st.fatal)}</p><p class="hint">En Ajustes del cliente → Descargas sin conexión puedes «Borrar todas» y empezar de cero.</p>`, settingsBtn); return; }
  if (st.expired) { rail(''); v.innerHTML = empty('wifioff', 'Las descargas caducaron', `<p>Pasaron más de ${esc(st.expireDays || 'varios')} días sin que el cliente se conecte a FLACo!. No se borró nada: al volver a tener internet y abrir la app se renuevan solas.</p><p class="hint">Puedes cambiar o quitar la caducidad en Ajustes del cliente → Descargas sin conexión.</p>`, (server ? `<a class="btn pri" href="${esc(server)}">Reintentar ahora</a>` : '') + settingsBtn); return; }
  if (!lib.length) { rail(''); v.innerHTML = empty('wifioff', manual ? 'Todavía no descargaste nada' : 'Sin conexión y sin temas descargados', manual ? '<p>Cuando descargues temas aparecerán acá y se podrán escuchar sin internet.</p>' : `<p>No pude conectar con ${esc(server || 'el servidor')}${why ? ' (' + esc(why) + ')' : ''}.</p><p class="hint">Reintento solo cada pocos segundos. Para escuchar sin conexión, descarga temas cuando tengas internet.</p>`, (server ? `<a class="btn pri" href="${esc(server)}">${manual ? 'Volver a FLACo!' : 'Reintentar ahora'}</a>` : '') + settingsBtn); return; }
  const total = lib.reduce((n, t) => n + (t.size || 0), 0), totalDur = lib.reduce((n, t) => n + (t.dur || 0), 0);
  if (kind === 'album' && albums.has(arg)) {
    rail('#/albums'); const a = albums.get(arg), ids = a.tracks.map((t) => t.id); setList(ids);
    const q = [...new Set(a.tracks.map((t) => qchip(t)[1]))], multi = Math.max(...a.tracks.map((t) => t.disc || 1)) > 1;
    let rows = '', last = 0; a.tracks.forEach((t, i) => { if (multi && t.disc !== last) { last = t.disc; rows += `<div class="tr hd"><span class="ix">${ic('albums', 'sm')}</span><span>Disco ${t.disc}</span></div>`; } rows += row(t, i, 'n'); });
    v.innerHTML = `<div class="hero"><div class="sleeve${S.cur && S.cur.album_id === a.id && a.id ? ' now' : ''}" data-al="${esc(a.key)}"><div class="disc"><i></i></div>${cover(a.id)}</div><div class="ht"><div class="sub">Álbum</div><h1 class="h">${esc(a.name)}</h1><div><a href="#/artist/${encodeURIComponent(a.artistKey)}"><b>${esc(a.artist)}</b></a>${a.year ? ' · ' + esc(a.year) : ''} · ${plural(a.tracks.length, 'canción', 'canciones')}, ${dur(a.tracks.reduce((n, t) => n + (t.dur || 0), 0))}</div><div class="chips"><span class="chip dl">${ic('download', 'sm')} Descargado</span><span class="chip">${q.length === 1 ? esc(q[0]) : 'Mezcla de ' + q.length + ' formatos'}</span></div>${acts()}</div></div><div class="tl">${rows}</div>`;
  } else if (kind === 'artist' && artists.has(arg)) {
    rail('#/artists'); const r = artists.get(arg); setList(r.tracks.slice().sort((a, b) => (a.album || '').localeCompare(b.album || '', 'es') || cmpTr(a, b)).map((t) => t.id));
    const list = shown.map((id) => byId.get(id));
    v.innerHTML = `<div class="hero">${r.cover ? `<img class="ava" src="../cover/${r.cover}" alt="">` : '<div class="ava"></div>'}<div class="ht"><div class="sub">Artista</div><h1 class="h">${esc(r.name)}</h1><div>${plural(r.albums.length, 'álbum', 'álbumes')} · ${plural(r.tracks.length, 'canción', 'canciones')}, ${dur(r.tracks.reduce((n, t) => n + (t.dur || 0), 0))}</div><div class="chips"><span class="chip dl">${ic('download', 'sm')} Descargado</span></div>${acts()}</div></div><h2 class="s">Álbumes</h2><div class="grid">${r.albums.map(albumCard).join('')}</div><h2 class="s">Canciones</h2><div class="tl flat">${list.map((t, i) => row(t, i, 'album')).join('')}</div>`;
  } else if (kind === 'albums') {
    rail('#/albums'); setList([]);
    v.innerHTML = `<h1 class="h sm">Explorar</h1><div class="seg"><a href="#/artists">Artistas</a><a href="#/albums" class="on">Álbumes</a></div><div class="grid top">${albList().map(albumCard).join('')}</div>`;
  } else if (kind === 'artists') {
    rail('#/artists'); setList([]);
    v.innerHTML = `<h1 class="h sm">Explorar</h1><div class="seg"><a href="#/artists" class="on">Artistas</a><a href="#/albums">Álbumes</a></div><div class="grid top">${artList().map(artistCard).join('')}</div>`;
  } else if (kind === 'songs') {
    rail('#/songs'); const l = lib.slice().sort((a, b) => String(a.title).localeCompare(String(b.title), 'es')); setList(l.map((t) => t.id));
    v.innerHTML = `<h1 class="h sm">Canciones</h1><div class="sub">${plural(lib.length, 'tema', 'temas')} · ${mb(total)}</div>${acts()}<div class="tl mid">${l.map((t, i) => row(t, i, 'artist')).join('')}</div>`;
  } else if (kind === 'search') {
    rail('#/search'); v.innerHTML = `<div class="sr">${ic('search')}<input id="q" type="search" placeholder="Buscar en lo descargado" autocomplete="off" value="${esc(sq)}"></div><div id="sres"></div>`;
    const run = () => { sq = $('q').value; const f = sq.trim().toLowerCase(), has = (s) => String(s || '').toLowerCase().includes(f);
      if (!f) { setList([]); $('sres').innerHTML = ''; return; }
      const al = albList().filter((a) => has(a.name) || has(a.artist)), ar = artList().filter((r) => has(r.name)), tr = lib.filter((t) => has(t.title) || has(t.artist) || has(t.album));
      setList(tr.map((t) => t.id));
      $('sres').innerHTML = (ar.length ? `<h2 class="s">Artistas</h2><div class="grid">${ar.map(artistCard).join('')}</div>` : '') + (al.length ? `<h2 class="s">Álbumes</h2><div class="grid">${al.map(albumCard).join('')}</div>` : '') + (tr.length ? `<h2 class="s">Canciones</h2><div class="tl flat">${tr.map((t, i) => row(t, i, 'artist')).join('')}</div>` : '') || '<div class="empty slim">Sin resultados</div>'; };
    $('q').addEventListener('input', run); $('q').focus(); run();
  } else {
    rail('#/'); setList([]);
    v.innerHTML = `<div class="hero top"><div class="ht"><div class="sub">Modo sin conexión</div><h1 class="h">Tu música,<br>sin internet</h1><div class="sub">${plural(lib.length, 'tema', 'temas')} · ${plural(albums.size, 'álbum', 'álbumes')} · ${plural(artists.size, 'artista', 'artistas')} · ${dur(totalDur)} · ${mb(total)}</div>${acts()}</div></div><h2 class="s">Álbumes</h2><div class="grid">${albList().map(albumCard).join('')}</div><h2 class="s">Artistas</h2><div class="grid">${artList().map(artistCard).join('')}</div>`;
  }
}
// una imagen que no existe (álbum sin carátula guardada) deja el placeholder de siempre
document.addEventListener('error', (e) => { const i = e.target; if (i && i.tagName === 'IMG') { const p = document.createElement('div'); p.className = 'nocov'; if (i.className === 'ava') p.className = 'ava'; if (i.id === 'cov') { i.hidden = true; $('covph').hidden = false; } else i.replaceWith(p); } }, true);

// ---- acciones ----
document.addEventListener('click', (e) => {
  const T = e.target; let el;
  if ((el = T.closest('[data-pa]'))) { e.preventDefault(); const a = albums.get(el.dataset.pa); if (a) start(a.tracks.map((t) => t.id), 0, false); return; }
  if ((el = T.closest('[data-pr]'))) { e.preventDefault(); const r = artists.get(el.dataset.pr); if (r) start(r.albums.flatMap((a) => a.tracks.map((t) => t.id)), 0, false); return; }
  if ((el = T.closest('[data-act]'))) {
    const ids = shown.length ? shown : lib.slice().sort((a, b) => String(a.artist).localeCompare(String(b.artist), 'es') || String(a.album).localeCompare(String(b.album), 'es') || cmpTr(a, b)).map((t) => t.id);
    start(ids, 0, el.dataset.act === 'shufall'); return;
  }
  if ((el = T.closest('.tr[data-i]'))) { if (shown.length) start(shown, +el.dataset.i, false); return; }
  if (T.closest('#retry')) { checkOnline(true); return; }
});
document.addEventListener('keydown', (e) => {
  const r = e.target.closest && e.target.closest('.tr[data-i]');
  if (r && e.key === 'Enter' && shown.length) start(shown, +r.dataset.i, false);
});
addEventListener('hashchange', route);

// ---- conexión: la comprueba el proceso principal (desde acá, un fetch no-cors a un 530 de Cloudflare parecería «conectado») ----
let checking = false;
async function checkOnline(manualTry) {
  if (checking || manual) return; checking = true;
  try {
    const on = (await (await fetch('../api/online', { cache: 'no-store' })).json()).online;
    if (on) {
      if (S.cur && !au.paused) { if (conn !== 'back') { conn = 'back'; offbar(); } } // no se corta la música sola: que decida el usuario
      else if (server) location.href = server;
    } else if (manualTry) toast('Sigue sin conexión con el servidor');
  } catch { if (manualTry) toast('Sigue sin conexión con el servidor'); } finally { checking = false; }
}
if (server && !manual) setInterval(() => checkOnline(false), Number(qs.get('p')) || 6000);

async function refreshState() { try { st = Object.assign(st, await (await fetch('../api/state')).json()); offbar(); } catch { /* sin datos */ } }
async function load() {
  let tracks = [];
  try { st = await (await fetch('../api/state')).json(); } catch { /* sin datos */ }
  if (st.ready) { try { const l = await (await fetch('../api/list')).json(); tracks = l.tracks || []; if (l.expired) st.expired = true; } catch { /* vacío */ } }
  lib = tracks; build(); offbar(); route();
}

// ---- reproducción ----
function start(ids, index, shuf) {
  if (!ids.length) return;
  if (shuf) index = Math.floor(Math.random() * ids.length);
  orig = ids.slice();
  shuffle = !!shuf; markShuffle();
  if (shuffle) { queue = shuffled(orig, index); qi = 0; } else { queue = orig.slice(); qi = index; }
  fails = 0;
  playIdx(qi);
}
function shuffled(ids, first) {
  const rest = ids.filter((_, i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return shuffle && ids[first] != null && first >= 0 ? [ids[first], ...rest] : rest;
}
function markShuffle() { $('bshuf').setAttribute('aria-pressed', shuffle ? 'true' : 'false'); }

function playIdx(i) {
  const t = byId.get(queue[i]);
  if (!t) return;
  qi = i;
  S.cur = { id: t.id, title: t.title, artist: t.artist, album: t.album, album_id: t.album_id, dur: t.dur };
  au.src = '../audio/' + t.id;
  au.play().catch((e) => toast('No pude reproducir: ' + (e && e.message || e)));
  $('ptitle').textContent = t.title;
  $('partist').innerHTML = `<a href="#/artist/${encodeURIComponent(artKey(t))}">${esc(t.artist || '')}</a>${t.album ? ' · <a href="#/album/' + encodeURIComponent(albKey(t)) + '">' + esc(t.album) + '</a>' : ''}`;
  if (t.album_id) { $('cov').src = '../cover/' + t.album_id; $('cov').hidden = false; $('covph').hidden = true; } else { $('cov').hidden = true; $('covph').hidden = false; }
  document.title = `${t.title} — ${t.artist} · FLACo!`;
  for (const r of document.querySelectorAll('.tr.cur')) r.classList.remove('cur');
  for (const r of document.querySelectorAll(`.tr[data-id="${t.id}"]`)) r.classList.add('cur');
  for (const s of document.querySelectorAll('.sleeve')) s.classList.toggle('now', !!t.album_id && s.dataset.al === String(t.album_id));
  setMedia(t); loadLyrics(t); recStart(t);
}

// ---- reproducciones: se anotan en el cliente y se cuentan en el servidor cuando vuelve la conexión (misma regla que la web:
// cuenta a los 30 s o a la mitad del tema; la vista, a los 30 s o a 3/4 si dura menos de 30 s) ----
let rec = null;
function recSend(upd) {
  if (!rec || !rec.counted) return;
  fetch('../api/played', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rec.id, sec: rec.sec, ts: rec.ts, view: rec.viewed, upd }) }).then(refreshState).catch(() => {});
}
function recStart(t) { recFlush(); rec = { id: t.id, ts: Date.now() / 1000, sec: 0, last: null, counted: false, viewed: false, dur: t.dur || 0 }; }
function recFlush() { if (rec && rec.counted) recSend(true); rec = null; }
function recTick() {
  if (!rec) return;
  const now = au.currentTime;
  if (rec.last != null) { const d = now - rec.last; if (d > 0 && d < 2) rec.sec += d; }
  rec.last = now;
  const d = isFinite(au.duration) && au.duration ? au.duration : rec.dur;
  if (!rec.counted && rec.sec >= Math.min(30, (d || 60) * 0.5)) { rec.counted = true; recSend(false); }
  if (!rec.viewed && rec.counted && rec.sec >= (d && d < 30 ? d * 0.75 : 30)) { rec.viewed = true; recSend(true); }
}
for (const ev of ['seeking', 'pause', 'play']) au.addEventListener(ev, () => { if (rec) rec.last = null; });
au.addEventListener('timeupdate', recTick);
au.addEventListener('ended', recFlush);
addEventListener('pagehide', recFlush);
function toggle() { if (!S.cur) return; if (au.paused) au.play().catch(() => {}); else au.pause(); }
function next() {
  if (qi + 1 < queue.length) playIdx(qi + 1);
  else { au.pause(); au.currentTime = 0; }
}
function prev() {
  if (au.currentTime > 3 || qi <= 0) au.currentTime = 0; else playIdx(qi - 1);
}
function toggleShuffle() {
  if (!orig.length) { shuffle = !shuffle; markShuffle(); return; }
  const cur = queue[qi];
  shuffle = !shuffle; markShuffle();
  if (shuffle) { const at = orig.indexOf(cur); queue = shuffled(orig, at); qi = 0; } else { queue = orig.slice(); qi = Math.max(0, orig.indexOf(cur)); }
}

const setPlayIcon = () => { $('bplay').innerHTML = ic(au.paused ? 'play' : 'pause'); };
au.addEventListener('play', () => { setPlayIcon(); document.body.classList.add('playing'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
au.addEventListener('pause', () => { setPlayIcon(); document.body.classList.remove('playing'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
au.addEventListener('ended', next);
au.addEventListener('playing', () => { fails = 0; });
au.addEventListener('error', () => {
  fails++;
  toast('No pude reproducir «' + (S.cur ? S.cur.title : '') + '»');
  if (fails < queue.length) setTimeout(next, 600); else { au.removeAttribute('src'); }
});
const setSeek = (p) => { $('ps').style.width = (p * 100) + '%'; };
au.addEventListener('timeupdate', () => {
  const d = isFinite(au.duration) ? au.duration : (S.cur && S.cur.dur) || 0;
  $('tcur').textContent = mmss(au.currentTime); $('tdur').textContent = mmss(d);
  if (!drag && d) { $('seek').value = Math.round(au.currentTime / d * 1000); setSeek(au.currentTime / d); }
  lyrTick();
});
$('seek').addEventListener('input', () => { drag = true; setSeek($('seek').value / 1000); });
$('seek').addEventListener('change', () => { const d = isFinite(au.duration) ? au.duration : 0; if (d) au.currentTime = $('seek').value / 1000 * d; drag = false; });
$('vol').addEventListener('input', () => { au.volume = $('vol').value / 100; $('bmute').innerHTML = ic(au.volume ? 'vol' : 'mute'); });
$('bmute').onclick = () => { if (au.volume) { $('bmute')._v = au.volume; au.volume = 0; $('vol').value = 0; } else { au.volume = $('bmute')._v || 0.9; $('vol').value = au.volume * 100; } $('bmute').innerHTML = ic(au.volume ? 'vol' : 'mute'); };
$('bplay').onclick = toggle; $('bnext').onclick = next; $('bprev').onclick = prev; $('bshuf').onclick = toggleShuffle;
$('blyr').onclick = () => { document.body.classList.toggle('po'); $('blyr').classList.toggle('on', document.body.classList.contains('po')); lyrTick(true); };
$('pclose').innerHTML = ic('x'); $('pclose').onclick = () => { document.body.classList.remove('po'); $('blyr').classList.remove('on'); };
$('bshuf').innerHTML = ic('shuffle'); $('bprev').innerHTML = ic('prev'); $('bnext').innerHTML = ic('next'); $('blyr').innerHTML = ic('lyrics'); $('bmute').innerHTML = ic('vol'); setPlayIcon();
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range') return;
  if (e.key === ' ' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight' && e.target.type !== 'range') au.currentTime = Math.min(au.duration || 1e9, au.currentTime + 5);
  else if (e.key === 'ArrowLeft' && e.target.type !== 'range') au.currentTime = Math.max(0, au.currentTime - 5);
});

let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3500); }

// ---- teclas multimedia / MPRIS ----
function setMedia(t) {
  if (!('mediaSession' in navigator)) return;
  const art = t.album_id ? [{ src: new URL('../cover/' + t.album_id, location.href).href, sizes: '640x640', type: 'image/jpeg' }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: art });
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* no soportado */ } };
  h('play', () => { if (au.paused) toggle(); }); h('pause', () => { if (!au.paused) toggle(); });
  h('previoustrack', prev); h('nexttrack', next);
  h('seekto', (d) => { au.currentTime = d.seekTime; });
  h('seekbackward', () => { au.currentTime = Math.max(0, au.currentTime - 10); }); h('seekforward', () => { au.currentTime += 10; });
}

// ---- letra ----
let lyrData = null, lyrFor = 0, lyrIdx = -1;
async function loadLyrics(t) {
  lyrFor = t.id; lyrData = null; lyrIdx = -1;
  const box = $('lyr'); box.textContent = '';
  const note = (m) => { const p = document.createElement('p'); p.className = 'plain'; p.textContent = m; box.append(p); };
  if (!t.lyr) { note('Este tema no tiene letra descargada.'); return; }
  try {
    const r = await fetch('../lyrics/' + t.id);
    if (!r.ok) throw new Error();
    const l = await r.json();
    if (lyrFor !== t.id) return;
    lyrData = l;
    for (const [i, ln] of (l.lines || []).entries()) {
      const p = document.createElement('p'); p.dataset.i = i; p.textContent = ln.text || '♪';
      if (!l.synced) p.className = 'plain'; else p.onclick = () => { if (ln.t != null) au.currentTime = ln.t; };
      box.append(p);
    }
  } catch { note('No pude leer la letra.'); }
}
function lyrTick(force) {
  if (!lyrData || !lyrData.synced || !document.body.classList.contains('po')) return;
  let k = -1;
  for (let i = 0; i < lyrData.lines.length; i++) { if (lyrData.lines[i].t != null && lyrData.lines[i].t <= au.currentTime + 0.15) k = i; else break; }
  if (k === lyrIdx && !force) return;
  lyrIdx = k;
  for (const p of $('lyr').children) p.classList.toggle('on', Number(p.dataset.i) === k);
  const cur = $('lyr').children[k];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

load();
