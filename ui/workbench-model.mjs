export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
export function shiftDate(date, days) {
  if (!validDate(date)) throw new Error('请选择有效日期');
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function obsidianUrl(value) {
  const target = String(value || '').trim();
  if (/^[a-z]:[\\/].+\.md$/i.test(target)) return 'obsidian://open?path=' + encodeURIComponent(target);
  let url;
  try { url = new URL(target); } catch { throw new Error('请填写笔记的完整路径，或粘贴 Obsidian 链接'); }
  const allowed = url.hostname === 'open' ? ['vault', 'file', 'path', 'paneType'] : url.hostname === 'search' ? ['vault', 'query'] : [];
  if (url.protocol !== 'obsidian:' || !allowed.length || url.username || url.password || url.port || (url.pathname && url.pathname !== '/') || url.hash || [...url.searchParams.keys()].some(key => !allowed.includes(key))) {
    throw new Error('请使用打开笔记或搜索的 Obsidian 链接');
  }
  if (!(url.searchParams.get('path') || url.searchParams.get('vault'))) throw new Error('Obsidian 链接需要包含知识库或笔记位置');
  return url.href;
}
export function webUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 http:// 或 https:// 地址'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写不带账号密码的 http:// 或 https:// 地址');
  return url.href;
}


export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
// A missing/removed entry stays visible without opening an unvalidated target.
export function linkedShortcuts(ids = [], shortcuts = []) {
  return ids.map(id => shortcuts.find(item => item.id === id && !item.deleted) || {id, title: '入口已移除', missing: true});
}

export function reminderDraft(task) {
  return {title: task.title, date: task.date, time: task.time || ''};
}

