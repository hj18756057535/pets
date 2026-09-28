const {randomUUID} = require('node:crypto');
function validateRepeat(value) {
  if (!value || !Array.isArray(value.days) || !value.days.length || value.days.some(d=>!Number.isInteger(d)||d<0||d>6) || !Number.isInteger(value.hour)||value.hour<0||value.hour>23 || !Number.isInteger(value.minute)||value.minute<0||value.minute>59 || !Number.isInteger(value.leadMinutes)||value.leadMinutes<0||value.leadMinutes>1440) throw new Error('固定会议规则无效');
  return {days:[...new Set(value.days)].sort(),hour:value.hour,minute:value.minute,leadMinutes:value.leadMinutes};
}
function nextOccurrence(reminder, now) {
  const rule = reminder.repeat;
  const after = Math.max(now + rule.leadMinutes*60000, Date.parse(reminder.meetingAt));
  const date = new Date(after); date.setHours(rule.hour,rule.minute,0,0);
  for(let i=0;i<9;i++) {
    if(date.getTime()>after && rule.days.includes(date.getDay())) return {...reminder,id:randomUUID(),meetingAt:date.toISOString(),dueAt:new Date(date.getTime()-rule.leadMinutes*60000).toISOString(),status:'pending',createdAt:new Date(now).toISOString()};
    date.setDate(date.getDate()+1); date.setHours(rule.hour,rule.minute,0,0);
  }
  throw new Error('无法计算下一次固定会议');
}
function activateReminders(state, ids, now=Date.now()) {
  const next=[];
  for(const reminder of state.reminders) if(ids.includes(reminder.id)) {
    reminder.status='active';
    if(reminder.repeat && !state.reminders.some(r=>r.seriesId===reminder.seriesId && r.id!==reminder.id && r.status==='pending')) next.push(nextOccurrence(reminder,now));
  }
  if(state.reminders.length+next.length>500) throw new Error('提醒记录已满，请清除已结束记录');
  state.reminders.push(...next);
}
module.exports={validateRepeat,nextOccurrence,activateReminders};
