import { dateValue, timeValue, nextHour, formatTime, manualTime, parseReminder } from './reminder-time.mjs';
import { Sprite } from './sprite.js';
const api = window.petdesk;
const $ = id => document.getElementById(id);
let state, sprite, filter = 'open', toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500); }
async function run(operation) { try { return await operation(); } catch (e) { toast(e.message); } }
function tab(name) {
  if (!['home', 'reminders', 'settings'].includes(name)) name = 'home';
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== name; });
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  $('page-title').textContent = { home: '今天，也一起好好工作。', reminders: '重要的事，有我记着。', settings: '舒服的陪伴，刚刚好。' }[name];
}
function dateText(value) { return formatTime(value); }
function openReminders() { return state.reminders.filter(r => r.status !== 'done').sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || Date.parse(a.dueAt) - Date.parse(b.dueAt)); }
function empty(text, icon = true) {
  const el = document.createElement('div'); el.className = 'empty-state';
  if (icon) { const symbol = document.createElement('span'); symbol.className = 'empty-icon'; symbol.textContent = '◷'; el.append(symbol); }
  el.append(document.createTextNode(text)); return el;
}
function item(reminder) {
  const row = document.createElement('div'); row.className = 'reminder-item'; row.dataset.reminderId = reminder.id;
  const heading = document.createElement('div'); heading.className = 'item-heading';
  const title = document.createElement('strong'); title.textContent = reminder.title;
  const badge = document.createElement('span'); badge.className = `status-badge ${reminder.status}`; badge.textContent = { pending: '待提醒', active: '待确认', done: '已结束' }[reminder.status]; heading.append(title, badge);
  const date = document.createElement('p'); date.className = 'item-date'; date.textContent = `${dateText(reminder.meetingAt)} 开始`;
  const due = document.createElement('p'); due.className = 'item-date'; due.textContent = `${dateText(reminder.dueAt)} 提醒`;
  const buttons = document.createElement('div'); buttons.className = 'item-actions';
  const options = reminder.status === 'active' ? [['done', '我知道了'], ['snooze', '5 分钟后再叫我']] : reminder.status === 'pending' ? [['done', '取消提醒']] : [['remove', '移除记录']];
  for (const [action, text] of options) {
    const button = document.createElement('button'); button.textContent = text; button.dataset.reminderAction = action;
    if (action === 'remove' || reminder.status === 'pending') button.className = 'muted';
    button.addEventListener('click', () => run(async () => { button.disabled = true; try { await api.reminderAction({ id: reminder.id, action }); } finally { button.disabled = false; } }));
    buttons.append(button);
  }
  row.append(heading, date, due, buttons); return row;
}
function render() {
  const open = openReminders(); const done = state.reminders.filter(r => r.status === 'done');
  $('pet-name').textContent = state.pet?.name || '还没有小伙伴';
  $('preview').hidden = !state.pet; $('no-pet').hidden = !!state.pet;
  $('show-pet').textContent = state.pet ? '让小伙伴回到桌面 ↗' : '先导入一位小伙伴';
  $('warning').textContent = state.warning; $('warning').hidden = !state.warning;
  $('nav-count').textContent = String(open.length); $('pending-count').textContent = String(open.length); $('done-count').textContent = String(done.length);
  $('quiet-top').classList.toggle('enabled', state.settings.quiet);
  $('quiet-top').querySelector('span').textContent = state.settings.quiet ? '免打扰中' : '免打扰';
  $('quiet-top').setAttribute('aria-pressed', String(state.settings.quiet));
  $('setting-quiet').checked = state.settings.quiet; $('setting-sound').checked = state.settings.sound; $('setting-motion').checked = state.settings.reducedMotion; $('setting-scale').value = String(state.settings.scale);
  $('setting-eye').checked = state.settings.eyeBreak;
  if (document.activeElement !== $('eye-minutes')) $('eye-minutes').value = String(state.settings.eyeMinutes);
  $('eye-preview').disabled = !state.settings.eyeBreak;
  $('eye-pending').hidden = !state.eyeReminder;
  $('eye-message').textContent = state.eyeReminder?.title || '';
  $('eye-status').textContent = !state.settings.eyeBreak ? '已关闭' : state.settings.quiet ? '免打扰中，暂停计时与气泡' : `已开启 · ${state.settings.eyeMinutes} 分钟一次`;
  if (sprite?.frames) { sprite.reduced = state.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches; sprite.draw(); }
  const next = open[0]; $('next-reminder').replaceChildren();
  if (next) {
    const time = document.createElement('div'); time.className = 'next-time'; time.textContent = new Date(next.meetingAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const title = document.createElement('p'); title.className = 'next-name'; title.textContent = next.title;
    const meta = document.createElement('p'); meta.className = 'next-meta'; meta.textContent = next.status === 'active' ? '已到提醒时间，等你确认' : `${dateText(next.dueAt)} 叫你`;
    $('next-reminder').append(time, title, meta);
  } else {
    const block = document.createElement('div'); block.className = 'next-empty';
    const title = document.createElement('strong'); title.textContent = '暂时没有安排，\n安心做自己的事。'; title.style.whiteSpace = 'pre-line';
    const text = document.createElement('p'); text.textContent = '有需要记住的事，就交给我吧。'; block.append(title, text); $('next-reminder').append(block);
  }
  const active = open.filter(r => r.status === 'active');
  $('inbox-count').textContent = active.length ? `· ${active.length} 条待确认` : '';
  $('home-inbox').replaceChildren(...(active.length ? active.slice(0, 2).map(item) : [empty('一切都好，目前没有需要确认的提醒。', false)]));
  const visible = filter === 'done' ? [...done].reverse() : open;
  $('list-count').textContent = `${visible.length} 条`;
  $('reminder-list').replaceChildren(...(visible.length ? visible.map(item) : [empty(filter === 'done' ? '结束的提醒会留在这里。' : '还没有安排，添加第一条提醒吧。')]));
}
function fillTime(date) { $('meeting-date').value = dateValue(date); $('meeting-time').value = timeValue(date); updateTimePreview(); }
function setDefaultTime() { fillTime(nextHour()); }
function selectedTime() { return manualTime($('meeting-date').value, $('meeting-time').value); }
function updateTimePreview() {
  try { const date = selectedTime(); if (date <= new Date()) throw new Error('所选时间已过去，请调整日期或时间'); const due = new Date(Math.max(Date.now(), date.getTime() - Number($('meeting-lead').value)*60000)); $('time-preview').textContent = formatTime(date) + ' 开始 · ' + (due.getTime() <= Date.now() ? '保存后立即提醒' : formatTime(due) + ' 提醒'); $('time-preview').classList.remove('invalid'); }
  catch(e) { $('time-preview').textContent = e.message; $('time-preview').classList.add('invalid'); }
}
for (const id of ['meeting-date','meeting-time','meeting-lead']) $(id).addEventListener('input', updateTimePreview);
$('meeting-time').addEventListener('blur', () => { try { $('meeting-time').value = timeValue(selectedTime()); } catch {} });
document.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => { if (b.dataset.day === 'hour') fillTime(nextHour()); else { const d = new Date(); d.setDate(d.getDate()+Number(b.dataset.day)); $('meeting-date').value = dateValue(d); updateTimePreview(); } $('meeting-weekday').value = ''; }));
$('meeting-weekday').addEventListener('change', () => { if ($('meeting-weekday').value === '') return; const d = new Date(); d.setDate(d.getDate()+(Number($('meeting-weekday').value)-d.getDay()+7)%7); let picked; try { picked = manualTime(dateValue(d),$('meeting-time').value); } catch { picked = d; } if (picked <= new Date()) d.setDate(d.getDate()+7); $('meeting-date').value = dateValue(d); updateTimePreview(); });
function parseQuick() { try { const result = parseReminder($('quick-reminder').value); $('meeting-title').value = result.title; fillTime(result.date); $('quick-error').textContent = ''; } catch(e) { $('quick-error').textContent = e.message; } }
$('parse-reminder').addEventListener('click', parseQuick);
$('quick-reminder').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); parseQuick(); } });
document.querySelectorAll('[data-template]').forEach(b => b.addEventListener('click', () => { $('quick-reminder').value = b.dataset.template; $('quick-reminder').focus(); $('quick-error').textContent = '可修改时间和事项，再点击“填入表单”。今天 / 周几已过的时间不会自动顺延。'; }));
$('pet-website').addEventListener('click', () => run(() => api.openPetWebsite()));
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => tab(button.dataset.tab)));
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); tab('home'); });
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); render(); }));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => run(async () => { sprite?.play(button.dataset.action, 3000); await api.play(button.dataset.action); })));
$('quiet-top').addEventListener('click', () => run(() => api.settings({ quiet: !state.settings.quiet })));
$('setting-eye').addEventListener('change', () => run(async () => { try { await api.settings({ eyeBreak: $('setting-eye').checked }); } finally { render(); } }));
$('eye-interval-form').addEventListener('submit', e => { e.preventDefault(); run(async () => { await api.settings({ eyeMinutes: Number($('eye-minutes').value) }); toast('护眼提醒间隔已保存，重新开始计时。'); }); });
document.querySelectorAll('[data-eye-minutes]').forEach(b => b.addEventListener('click', () => run(() => api.settings({ eyeMinutes: Number(b.dataset.eyeMinutes) }))));
$('eye-preview').addEventListener('click', () => run(async () => { await api.previewEyeBreak(); toast(state.settings.quiet ? '体验文案已显示在设置中；关闭免打扰可查看气泡。' : '小纸条准备好啦；有会议提醒时会优先显示会议。'); }));
$('eye-done').addEventListener('click', () => run(() => api.eyeBreakAction('done')));
$('eye-snooze').addEventListener('click', () => run(() => api.eyeBreakAction('snooze')));
for (const [id, key] of [['setting-quiet', 'quiet'], ['setting-sound', 'sound'], ['setting-motion', 'reducedMotion']]) $(id).addEventListener('change', () => run(async () => { try { await api.settings({ [key]: $(id).checked }); } catch (e) { render(); throw e; } }));
$('setting-scale').addEventListener('change', () => run(() => api.settings({ scale: Number($('setting-scale').value) })));
$('show-pet').addEventListener('click', () => run(() => state.pet ? api.showPet() : openImport()));
$('import-pet').addEventListener('click', openImport);
$('dock-pet').addEventListener('click', () => run(async () => { await api.dockPet(); toast('已收起到侧边，点击侧边小按钮即可展开。'); }));
$('hide-pet').addEventListener('click', () => run(async () => { await api.hidePet(); toast('桌宠已隐藏，提醒仍会保留在列表中。'); }));
$('quit').addEventListener('click', () => api.quit());
$('reminder-form').addEventListener('submit', async e => {
  e.preventDefault(); $('form-error').textContent = ''; $('save-reminder').disabled = true;
  try { const time = selectedTime(); if (!Number.isFinite(time.getTime())) throw new Error('请选择正确的会议时间'); await api.addReminder({ title: $('meeting-title').value, meetingAt: time.toISOString(), leadMinutes: Number($('meeting-lead').value) }); $('meeting-title').value = ''; $('quick-reminder').value = ''; toast('记住啦，到时间我来叫你。'); }
  catch (error) { $('form-error').textContent = error.message; }
  finally { $('save-reminder').disabled = false; }
});
$('test-reminder').addEventListener('click', () => run(async () => {
  $('test-reminder').disabled = true;
  try { await api.addReminder({ title: '和小伙伴的第一次提醒', meetingAt: new Date(Date.now() + 10000).toISOString(), leadMinutes: 0 }); toast('已安排，10 秒后见。'); }
  finally { $('test-reminder').disabled = false; }
}));
api.onState(value => { state = value; render(); }); api.onTab(tab);
let importCandidate = null, importSprite = null, importBusy = false, applying = false, importGeneration = 0;
function importControls(busy) {
  importBusy = busy;
  for (const id of ['import-zip', 'import-folder', 'import-fetch', 'import-url']) $(id).disabled = busy;
  $('import-apply').disabled = busy || !importCandidate;
  $('import-status').classList.toggle('busy', busy);
}
function openImport() {
  $('import-error').hidden = true;
  $('import-preview').hidden = true;
  $('import-status').textContent = '支持 .codex-pet.zip、普通 ZIP 和宠物文件夹。';
  importCandidate = null; importControls(false); $('import-dialog').showModal();
}
function closeImport() {
  if (applying) return;
  importGeneration++; importCandidate = null; importSprite?.destroy(); importSprite = null;
  api.cancelImport().catch(() => {}); $('import-dialog').close(); importControls(false);
}
async function previewImport(load) {
  const generation = ++importGeneration;
  importCandidate = null; importSprite?.destroy(); importSprite = null;
  $('import-preview').hidden = true; $('import-error').hidden = true;
  $('import-status').textContent = '正在读取宠物并检查资源，请稍等…'; importControls(true);
  try {
    const candidate = await load();
    if (generation !== importGeneration) return;
    if (!candidate) { $('import-status').textContent = '没有选择文件，当前宠物保持不变。'; return; }
    const previewSprite = new Sprite($('import-canvas'), candidate.image);
    importSprite = previewSprite;
    await previewSprite.ready;
    if (generation !== importGeneration) { previewSprite.destroy(); return; }
    importCandidate = candidate;
    $('import-name').textContent = candidate.name; $('import-description').textContent = candidate.description;
    $('import-version').textContent = `Codex V${candidate.version} · 已读取`;
    $('import-preview').hidden = false; $('import-status').textContent = '预览就绪，喜欢的话就把它带到桌面吧。';
  } catch (e) {
    if (generation !== importGeneration) return;
    $('import-error').textContent = e.message; $('import-error').hidden = false;
    $('import-status').textContent = '没有切换宠物，可以重新选择文件或链接。';
    await api.cancelImport().catch(() => {});
  } finally { if (generation === importGeneration) importControls(false); }
}
$('import-close').addEventListener('click', closeImport);
$('import-dialog').addEventListener('cancel', e => { e.preventDefault(); closeImport(); });
$('import-zip').addEventListener('click', () => previewImport(() => api.importPet('zip')));
$('import-folder').addEventListener('click', () => previewImport(() => api.importPet('folder')));
$('import-link-form').addEventListener('submit', e => { e.preventDefault(); if (!importBusy) previewImport(() => api.previewPetLink($('import-url').value)); });
$('import-apply').addEventListener('click', async () => {
  if (importBusy || !importCandidate) return;
  const candidate = importCandidate; applying = true; importControls(true);
  try {
    await api.applyPet(candidate.token);
    sprite?.destroy(); sprite = new Sprite($('preview'), candidate.image); await sprite.ready;
    render(); applying = false; closeImport(); toast(`欢迎 ${candidate.name}，已经换好啦。`);
  } catch (e) { $('import-error').textContent = e.message; $('import-error').hidden = false; }
  finally { applying = false; importControls(false); }
});
try {
  state = await api.init();
  if (state.image) { sprite = new Sprite($('preview'), state.image); await sprite.ready; }
  $('today').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  setDefaultTime(); render(); tab(state.tab); window.__ready = true;
} catch (e) { $('warning').textContent = e.message; $('warning').hidden = false; }
