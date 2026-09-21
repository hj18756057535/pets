const pad = n => String(n).padStart(2, '0');
export function dateValue(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
export function timeValue(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function nextHour(now = new Date()) { const d = new Date(now); d.setHours(d.getHours()+1, 0, 0, 0); return d; }
export function formatTime(value, now = new Date()) {
  const d = new Date(value), tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate()+1);
  const day = dateValue(d) === dateValue(now) ? '今天' : dateValue(d) === dateValue(tomorrow) ? '明天' : `${d.getFullYear() !== now.getFullYear() ? d.getFullYear()+'年' : ''}${d.getMonth()+1}月${d.getDate()}日`;
  return `${day} 周${'日一二三四五六'[d.getDay()]} · ${timeValue(d)}`;
}
export function manualTime(day, clock) {
  const match = /^(\d{1,2})(?::|：)?(\d{2})?$/.exec(clock.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !match) throw new Error('时间可输入 9、930 或 09:30（24 小时制）');
  const h = Number(match[1]), m = Number(match[2] || 0);
  if (h > 23 || m > 59) throw new Error('请输入 00:00 到 23:59 之间的时间');
  const d = new Date(`${day}T${pad(h)}:${pad(m)}:00`);
  if (!Number.isFinite(d.getTime()) || dateValue(d) !== day || d.getHours() !== h || d.getMinutes() !== m) throw new Error('这个日期或时间不存在');
  return d;
}
export function parseReminder(text, now = new Date()) {
  const match = /^(今天|明天|后天|(?:下周|周|星期)[一二三四五六日天])\s*(上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?:(?:[:：](\d{2})(?!\d))|(?:点(?:(半)|(\d{1,2})分?)?)|(?=\s))\s*(?:有一个|有个)?\s*(.+)$/.exec(text.trim());
  if (!match) throw new Error('试试：今天下午3点项目会、明天 09:30 晨会、周三14点需求评审');
  const [,day,period,hour,minute,half,pointMinute,title] = match;
  let h = Number(hour), m = half ? 30 : Number(minute || pointMinute || 0);
  if (period && (h < 1 || h > 12)) throw new Error('带上午 / 下午时，请使用 1 到 12 点');
  if (period && ['下午','晚上','中午'].includes(period) && h < 12) h += 12;
  if (period && ['上午','早上'].includes(period) && h === 12) h = 0;
  const d = new Date(now); d.setHours(0,0,0,0);
  if (['今天','明天','后天'].includes(day)) d.setDate(d.getDate()+['今天','明天','后天'].indexOf(day));
  else {
    const target = '日一二三四五六'.indexOf(day.slice(-1).replace('天','日'));
    const offset = day.startsWith('下周') ? (7-(d.getDay()+6)%7)+(target+6)%7 : (target-d.getDay()+7)%7;
    d.setDate(d.getDate()+offset);
  }
  const result = manualTime(dateValue(d), `${h}:${pad(m)}`);
  if (result <= now) throw new Error('这个时间已经过去，请改为明天、下周或选择其他日期');
  if (!title.trim() || title.trim().length > 100) throw new Error('事项名称需要 1 到 100 个字');
  return { date: result, title: title.trim() };
}
