'use strict';
// Script que se evalúa dentro de la página de FLACo! para saber qué suena.
// Usa el estado global de la UI web: const S (cola, tema actual, cuenta), A() (el <audio> activo).
const READ_JS = `(()=>{try{
  if(typeof S==='undefined'||typeof A!=='function')return null;
  const a=A(),t=S.cur;
  return{id:t?t.id:0,title:t?t.title:'',artist:t?t.artist:'',album:t?t.album:'',album_id:t?t.album_id:0,
   dur:(a&&isFinite(a.duration)&&a.duration)||(t&&t.dur)||0,pos:a?(a.currentTime||0):0,
   playing:!!a&&!a.paused&&!!a.src,share:S.me?S.me.share_now!==false:null}
}catch(e){return null}})()`;

module.exports = { READ_JS };
