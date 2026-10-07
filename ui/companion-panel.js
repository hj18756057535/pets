import {dayKey, liveStreak, mood, monthCells} from './companion.mjs';
const $ = id => document.getElementById(id);
let state, month = new Date(), selected = dayKey();
export function setupCompanion(api, run, toast, selectDate) {
  $('check-in').onclick = () => run(async () => {
    $('check-in').disabled = true;
    try { toast(await api.checkIn() ? '签到成功，火花续上啦！' : '今天已经签到啦，明天再来续火花。'); }
    finally { renderCompanion(state); }
  });
  for (const [id, key] of [['mood-enabled','moodEnabled'],['holiday-enabled','holidayEnabled']]) {
    $(id).onchange = () => run(async () => { try { await api.companionConfig({[key]:$(id).checked}); } finally { renderCompanion(state); } });
  }
  $('mood-form').onsubmit = event => { event.preventDefault(); void run(async () => { await api.companionConfig({moodMinutes:Number($('mood-minutes').value)}); toast('情绪表达间隔已保存'); }); };
  for (const [id, delta] of [['calendar-prev',-1],['calendar-next',1]]) $(id).onclick = () => { month = new Date(month.getFullYear(),month.getMonth()+delta,1); renderCompanion(state); };
  $('calendar-today').onclick = () => { month = new Date(); selected = dayKey(); renderCompanion(state); };
  $('calendar-add').onclick = () => selectDate(selected);
  setInterval(() => { if (state && !document.hidden) renderCompanion(state); }, 30000);
}
export function renderCompanion(value) {
  if (!value) return;
  state = value;
  const c = state.companion, streak = liveStreak(c);
  $('spark-streak').textContent = `🔥 ${streak} 天火花`;
  $('spark-total').textContent = `累计签到 ${c.total} 天 · ${streak ? '每天来见一面，火花就能延续。' : '今天签到，点亮新的火花。'}`;
  $('check-in').disabled = c.lastCheckIn === dayKey();
  $('check-in').textContent = c.lastCheckIn === dayKey() ? '今日已签到 ✓' : '签到 · 续火花';
  $('current-mood').textContent = `当前心情：${mood(c).name}`;
  $('mood-enabled').checked = c.moodEnabled;
  $('holiday-enabled').checked = c.holidayEnabled;
  if (document.activeElement !== $('mood-minutes')) $('mood-minutes').value = c.moodMinutes;
  $('calendar-title').textContent = `${month.getFullYear()} 年 ${month.getMonth()+1} 月`;
  const cells = monthCells(month.getFullYear(),month.getMonth());
  $('calendar-grid').replaceChildren(...cells.map(date => {
    if (!date) { const blank = document.createElement('span'); blank.setAttribute('aria-hidden','true'); return blank; }
    const key = dayKey(date), button = document.createElement('button');
    const holiday = state.holidays.find(h=>h.month===date.getMonth()+1 && h.day===date.getDate());
    const count = state.reminders.filter(r=>r.status!=='done' && dayKey(new Date(r.meetingAt))===key).length;
    button.type = 'button'; button.className = 'calendar-day';
    button.classList.toggle('selected',key===selected); button.classList.toggle('today',key===dayKey());
    button.setAttribute('aria-pressed',String(key===selected));
    button.setAttribute('aria-label',`${key}${holiday ? ' '+holiday.title : ''}，${count} 条事项`);
    const number = document.createElement('strong'); number.textContent = date.getDate();
    const label = document.createElement('small'); label.textContent = holiday?.title || (count ? `${count} 条事项` : '');
    button.append(number,label); button.onclick = () => { selected = key; renderCompanion(state); }; return button;
  }));
  $('calendar-selected').textContent = `${selected} 的安排`;
  const reminders = state.reminders.filter(r=>r.status!=='done' && dayKey(new Date(r.meetingAt))===selected).sort((a,b)=>Date.parse(a.meetingAt)-Date.parse(b.meetingAt));
  const holiday = state.holidays.find(h=>h.month===Number(selected.slice(5,7)) && h.day===Number(selected.slice(8)));
  const lines = reminders.map(r=>`${new Date(r.meetingAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · ${r.title}`);
  if (holiday) lines.unshift(`${holiday.title} · ${c.holidayEnabled ? '当天 09:00 起自动提醒' : '节日提醒已关闭'}`);
  $('calendar-events').replaceChildren(...(lines.length?lines:['这一天还没有安排。']).map(line=>{const p=document.createElement('p');p.textContent=line;return p;}));
}
