import { formatTime } from './reminder-time.mjs';
import { Sprite } from './sprite.js';
const api = window.petdesk; const canvas = document.getElementById('pet');
let moving = false;
let state, sprite, current, pointerDown = null, dragged = false;
function layout(value) {
  if (!value) return;
  const root = document.documentElement;
  root.style.setProperty('--bubble-left', `${value.bubbleLeft ?? 10}px`);
  root.style.setProperty('--pet-left', `${value.offset.x}px`);
  root.style.setProperty('--pet-top', `${value.offset.y}px`);
  root.style.setProperty('--bubble-below-top', `${value.offset.y + 156 * state.settings.scale + 10}px`);
  root.style.setProperty('--bubble-above-bottom', `${value.bounds.height - value.offset.y + 10}px`);
  root.style.setProperty('--tail-left', `${Math.max(15, Math.min(270, value.offset.x + 72 * state.settings.scale - (value.bubbleLeft ?? 10) - 5))}px`);
  document.body.classList.toggle('bubble-below', value.below);
}
api.onPetLayout(value => { if (state) { state.petLayout = value; layout(value); } });
function render() {
  layout(state.petLayout);
  document.documentElement.style.setProperty('--pet-scale', state.settings.scale);
  const active = state.reminders.filter(r => r.status === 'active').sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const rest = state.eyeReminder;
  current = active[0] || (rest ? { ...rest, kind: 'eye' } : null);
  const total = active.length + (rest ? 1 : 0);
  document.getElementById('bubble').hidden = moving || !!state.interaction || !current || state.settings.quiet;
  if (current) {
    const eye = current.kind === 'eye';
    document.querySelector('.bubble-label').firstChild.nodeValue = eye ? '小伙伴喊你歇一会儿 ' : '有件事要告诉你 ';
    document.getElementById('bubble-time').textContent = eye ? current.hint : formatTime(current.meetingAt) + ' 开始';
    document.getElementById('bubble-title').textContent = current.title;
    document.getElementById('bubble-count').textContent = total > 1 ? `${total} 条` : '';
    document.getElementById('ack').textContent = eye ? '去歇会儿' : '知道啦';
    document.getElementById('all').setAttribute('aria-label', eye ? '护眼提醒设置' : '查看所有提醒');
  }
  if (sprite) { sprite.reduced = state.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches; if (!moving) sprite.play(current && !state.settings.quiet ? 'waiting' : 'idle'); }
}
function hit(point) {
  if (pointerDown) return;
  const target = document.elementFromPoint(point.x, point.y);
  api.hitTest(!!target?.closest('[data-interactive]') || !!sprite?.hit(point.x, point.y));
}
api.onPointer(hit);
api.onMotion(value => { moving = value.moving; document.body.classList.toggle('moving', moving); sprite?.play(value.action); render(); });
document.addEventListener('dragstart', e => e.preventDefault());
api.onDragEnded(() => { pointerDown = null; dragged = false; });
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
window.addEventListener('pointerup', release, true);
window.addEventListener('blur', () => release());
document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
canvas.addEventListener('dblclick', () => api.showPanel('home'));
document.addEventListener('contextmenu', e => { e.preventDefault(); api.openPetMenu().catch(() => api.showPanel('home')); });
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
    sprite.keepAnimating = true;
  }
  render(); window.__ready = true; await api.reportReady();
}
catch { api.showPanel('home'); }
