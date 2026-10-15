'use strict';
const q = new URLSearchParams(location.search);
const u = q.get('u') || '';
document.getElementById('where').textContent = u;
document.getElementById('why').textContent = (q.get('e') || '').replace(/^net::/, '');
const retry = document.getElementById('retry');
retry.href = u;
const probe = () => fetch(u, { mode: 'no-cors', cache: 'no-store' }).then(() => { location.href = u; }).catch(() => {});
setInterval(probe, 8000);
