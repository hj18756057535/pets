const test = require('node:test');
const assert = require('node:assert/strict');
test('签到显示使用本地自然日，跨年续火花，漏签熄灭', async () => {
  const {liveStreak,dayKey} = await import('../ui/companion.mjs');
  const c = {lastCheckIn:'2026-12-31',streak:9};
  assert.equal(dayKey(new Date(2027,0,1,0,1)), '2027-01-01');
  assert.equal(liveStreak(c,new Date(2027,0,1)),9);
  assert.equal(liveStreak(c,new Date(2027,0,2)),0);
});
test('月历周一起始，支持闰年和跨年', async () => {
  const {monthCells,dayKey} = await import('../ui/companion.mjs');
  const cells = monthCells(2028,1);
  assert.equal(cells.filter(Boolean).length,29);
  assert.equal(cells.indexOf(cells.find(Boolean)),1);
  assert.equal(dayKey(cells.at(-1)),'2028-02-29');
  assert.equal(dayKey(monthCells(2026,12).find(Boolean)),'2027-01-01');
});
test('情绪随签到、时段变化，同类文案轮换', async () => {
  const {mood} = await import('../ui/companion.mjs');
  const c = {lastCheckIn:'2026-10-02'};
  assert.equal(mood(c,new Date(2026,9,2,10)).name,'开心');
  assert.equal(mood(c,new Date(2026,9,2,23)).name,'困困的');
  assert.equal(mood(c,new Date(2026,9,3,13)).name,'慵懒');
  assert.equal(mood(c,new Date(2026,9,3,10)).name,'期待');
  assert.notEqual(mood(c,new Date(2026,9,2,10),0).lines,mood(c,new Date(2026,9,2,10),1).lines);
});
