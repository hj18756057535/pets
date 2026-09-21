const test = require('node:test');
const assert = require('node:assert/strict');
const moduleReady = import('../ui/reminder-time.mjs');
const now = new Date(2026,8,19,10,15);
test('快捷输入支持下午、半点、周几和下周，保留会议名称', async () => {
  const {parseReminder,dateValue,timeValue} = await moduleReady;
  for (const [input,day,time,title] of [
    ['今天下午3点项目会','2026-09-19','15:00','项目会'],
    ['明天 09:30 晨会','2026-09-20','09:30','晨会'],
    ['周三14点需求评审','2026-09-23','14:00','需求评审'],
    ['下周一上午9点半有一个项目会议','2026-09-21','09:30','项目会议'],
    ['今天中午12点午餐','2026-09-19','12:00','午餐']]) {
    const result = parseReminder(input,now);
    assert.equal(dateValue(result.date),day); assert.equal(timeValue(result.date),time); assert.equal(result.title,title);
  }
});
test('不把过期、越界或不完整输入悄悄调整到其他时间', async () => {
  const {parseReminder,manualTime} = await moduleReady;
  for (const input of ['今天9点会议','周六9点会议','明天25点会议','明天09:99会议','明天930会议','明天9点','明天下午15点会议']) assert.throws(()=>parseReminder(input,now),input);
  assert.throws(()=>manualTime('2026-02-30','09:00'));
  assert.throws(()=>manualTime('2026-09-20','24:00'));
});
test('手动输入和下个整点正确处理午夜、月底与跨年', async () => {
  const {manualTime,timeValue,nextHour,dateValue,formatTime} = await moduleReady;
  for (const value of ['930','09:30','9：30']) assert.equal(timeValue(manualTime('2026-09-20',value)),'09:30');
  assert.equal(timeValue(manualTime('2026-09-20','9')),'09:00');
  const d = nextHour(new Date(2026,11,31,23,59));
  assert.equal(dateValue(d),'2027-01-01'); assert.equal(timeValue(d),'00:00');
  assert.match(formatTime(new Date(2027,0,3,9),now),/2027年/);
});
