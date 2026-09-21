import { formatTime } from './reminder-time.mjs';
import { Sprite } from './sprite.js';
const api = window.petdesk; const canvas = document.getElementById('pet');
let state, sprite, current, pointerDown = null, dragged = false;
function render() {
  document.documentElement.style.setProperty('--pet-scale', state.settings.scale);
  const active = state.reminders.filter(r => r.status === 'active').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const rest = state.eyeReminder;
  current = active[0] || (rest ? { ...rest, kind: 'eye' } : null);
  const total = active.length + (rest ? 1 : 0);
  const docked = !!state.dock;
  document.body.classList.toggle('docked', docked);
  document.body.classList.toggle('edge-left', !docked && state.petEdge === 'left');
  document.body.classList.toggle('edge-right', !docked && state.petEdge === 'right');
  const edge = document.getElementById('edge-tab');
  edge.hidden = !docked;
  edge.classList.toggle('left', state.dock?.side === 'left');
  document.getElementById('edge-arrow').textContent = state.dock?.side === 'left' ? '›' : '‹';
  const count = document.getElementById('edge-count');
  count.hidden = !total || state.settings.quiet;
  count.textContent = total > 9 ? '9+' : String(total);
  edge.title = total ? `${total} 条提醒待确认，点击展开` : '点击展开桌宠';
  document.getElementById('bubble').hidden = !current || state.settings.quiet;
  if (current) {
    const eye = current.kind === 'eye';
    document.querySelector('.bubble-label').firstChild.nodeValue = eye ? '小伙伴喊你歇一会儿 ' : '有件事要告诉你 ';
    document.getElementById('bubble-time').textContent = eye ? current.hint : formatTime(current.meetingAt) + ' 开始';
    document.getElementById('bubble-title').textContent = current.title;
    document.getElementById('bubble-count').textContent = total > 1 ? `${total} 条` : '';
    document.getElementById('ack').textContent = eye ? '去歇会儿' : '知道啦';
    document.getElementById('all').setAttribute('aria-label', eye ? '护眼提醒设置' : '查看所有提醒');
  }
  if (sprite) { sprite.paused = docked; sprite.reduced = state.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches; sprite.play(current && !state.settings.quiet ? 'waiting' : 'idle'); }
}
function hit(point) {
  if (pointerDown) return;
  const target = document.elementFromPoint(point.x, point.y);
  api.hitTest(!!target?.closest('[data-interactive]') || !!sprite?.hit(point.x, point.y));
}
api.onPointer(hit);
document.addEventListener('mousemove', e => hit({ x: e.clientX, y: e.clientY }));
document.addEventListener('mouseleave', () => { if (!pointerDown) api.hitTest(false); });
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !sprite?.hit(e.clientX, e.clientY)) return;
  pointerDown = { x: e.screenX, y: e.screenY }; dragged = false;
  canvas.setPointerCapture(e.pointerId); api.dragStart();
});
canvas.addEventListener('pointermove', e => { if (pointerDown && Math.hypot(e.screenX - pointerDown.x, e.screenY - pointerDown.y) > 4) dragged = true; });
function release(e) { if (!pointerDown) return; pointerDown = null; api.dragEnd(); if (!dragged) sprite?.play('waving', 2200); if (e && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); }
canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release); canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('dblclick', () => api.showPanel('home'));
document.addEventListener('contextmenu', e => { e.preventDefault(); api.showPanel('home'); });
document.getElementById('edge-tab').addEventListener('click', () => api.expandPet().catch(() => api.showPanel('settings')));
document.getElementById('all').addEventListener('click', () => api.showPanel(current?.kind === 'eye' ? 'settings' : 'reminders'));
for (const [id, action] of [['ack', 'done'], ['snooze', 'snooze']]) document.getElementById(id).addEventListener('click', async () => {
  if (!current) return;
  const button = document.getElementById(id); button.disabled = true;
  try { if (current.kind === 'eye') await api.eyeBreakAction(action); else await api.reminderAction({ id: current.id, action }); } catch { api.showPanel('settings'); } finally { button.disabled = false; }
});
api.onState(value => { state = value; render(); });
api.onPlay(action => sprite?.play(action, 3000));
try {
  state = await api.init();
  if (state.image) {
    sprite = new Sprite(canvas, state.image); await sprite.ready;
    document.getElementById('edge-face').getContext('2d').drawImage(sprite.image, 0, 0, 192, 208, 0, 0, 192, 208);
  }
  render(); window.__ready = true;
}
catch { api.showPanel('home'); }
