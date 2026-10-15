import { Sprite } from './sprite.js';
const api = window.petdesk;
const canvas = document.getElementById('pet');
let sprite, down, dragged = false;
function configure(value) {
  if (!sprite) return;
  sprite.paused = !value.visible;
  sprite.reduced = value.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (sprite.frames) sprite.draw();
}
function hit(point) { if (!down) api.hitTest(!!sprite?.hit(point.x, point.y)); }
api.onPointer(hit);
api.onPlay(action => sprite?.play(action, 3000));
api.onDragEnded(() => { down = null; dragged = false; });
document.addEventListener('mousemove', e => hit({x:e.clientX,y:e.clientY}));
document.addEventListener('mouseleave', () => { if (!down) api.hitTest(false); });
document.addEventListener('dragstart', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !sprite?.hit(e.clientX, e.clientY)) return;
  down = {x:e.screenX,y:e.screenY}; dragged = false;
  canvas.setPointerCapture(e.pointerId); api.dragStart();
});
canvas.addEventListener('pointermove', e => {
  if (down && Math.hypot(e.screenX-down.x,e.screenY-down.y)>4) dragged=true;
});
function release(e) {
  if (!down) return;
  down = null; api.dragEnd();
  if (!dragged) sprite?.play('waving',2200);
  if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}
for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name,release);
window.addEventListener('pointerup',release,true);
window.addEventListener('blur',()=>release());
document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
canvas.addEventListener('dblclick',()=>api.showPanel('home'));
document.addEventListener('contextmenu',e=>{e.preventDefault();api.showPanel('home');});
try {
  await window.__TAURI__.event.listen('companion-settings',({payload})=>configure(payload));
  let state;
  for (let attempt=0;attempt<20;attempt++) {
    try { state=await api.init(); break; }
    catch(error) { if(attempt===19)throw error; await new Promise(resolve=>setTimeout(resolve,100)); }
  }
  sprite=new Sprite(canvas,state.image); await sprite.ready;
  configure(state); window.__ready=true; await api.reportReady();
} catch (error) { window.__loadError=String(error); console.error('陪伴宠物加载失败',error); }
