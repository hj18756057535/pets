const test=require('node:test'); const assert=require('node:assert/strict');
const {makeReminder,validateState,defaults}=require('../src/core.cjs');
const {activateReminders}=require('../src/recurrence.cjs');
test('固定会议到期生成下一次，不依赖本次确认，不重复生成',()=>{
 const start=new Date(2026,8,21,9); const r=makeReminder({title:'晨会',meetingAt:start.toISOString(),leadMinutes:5,repeatDays:[1,2,3,4,5]},start-600000);
 const s=defaults();s.reminders=[r];activateReminders(s,[r.id],start-300000);
 assert.equal(s.reminders.length,2);assert.equal(s.reminders[0].status,'active');
 assert.equal(new Date(s.reminders[1].meetingAt).getDate(),22);assert.equal(s.reminders[1].seriesId,r.id);
 activateReminders(s,[r.id],+start);assert.equal(s.reminders.length,2);
 assert.deepEqual(validateState(s).reminders,s.reminders);
});
test('离线多周只补一条并安排未来场次，周五后跳过周末',()=>{
 const start=new Date(2026,8,25,9);const r=makeReminder({title:'例会',meetingAt:start.toISOString(),repeatDays:[1,2,3,4,5]},start-10000);
 const s=defaults();s.reminders=[r];activateReminders(s,[r.id],+start);
 assert.equal(new Date(s.reminders[1].meetingAt).getDate(),28);
 const later=new Date(2027,0,4,12);const t=defaults();t.reminders=[r];activateReminders(t,[r.id],+later);
 assert.equal(t.reminders.length,2);assert.ok(Date.parse(t.reminders[1].dueAt)>later);
});
test('拒绝空星期、越界星期及首次日期不在重复规则内',()=>{
 const start=new Date(2026,8,21,9);
 for(const repeatDays of [[],[7],[2]]) assert.throws(()=>makeReminder({title:'会',meetingAt:start.toISOString(),repeatDays},start-10000));
});
