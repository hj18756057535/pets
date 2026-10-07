export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export function liveStreak(companion, now = new Date()) {
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  return [dayKey(now), dayKey(yesterday)].includes(companion.lastCheckIn) ? companion.streak : 0;
}
export function mood(companion, now = new Date(), variation = 0) {
  const hour = now.getHours();
  if (hour >= 23 || hour < 6) return {name:'困困的', action:'idle', lines:['眼皮开始打架啦，我陪你慢慢收尾。','打个哈欠，今天也辛苦你了。'][variation % 2]};
  if (companion.lastCheckIn === dayKey(now)) return {name:'开心', action:'waving', lines:['今天的火花续上啦，心里暖暖的！','有你在，今天也是值得摇尾巴的一天。'][variation % 2]};
  if (hour >= 12 && hour < 14) return {name:'慵懒', action:'idle', lines:['午后的我，想和阳光一起打个盹。','伸个懒腰，慢慢来也挺好。'][variation % 2]};
  return {name:'期待', action:'waving', lines:['想你来摸摸头，今天也一起攒火花吧。','我在这里陪着你，准备好一起开始啦。'][variation % 2]};
}
export function monthCells(year, month) {
  const offset = (new Date(year, month, 1).getDay()+6)%7;
  const count = new Date(year, month+1, 0).getDate();
  return [...Array(offset).fill(null), ...Array.from({length:count}, (_,i)=>new Date(year,month,i+1))];
}
