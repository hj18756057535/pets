const test = require('node:test');
const assert = require('node:assert/strict');
const { EyeBreak, lines } = require('../src/eye-break.cjs');
const { defaults, validateState } = require('../src/core.cjs');
const options = {enabled:true, minutes:5, quiet:false, idleSeconds:0};
function advance(clock, seconds, changes = {}) { let changed = false; for(let i=0;i<seconds;i++) changed = clock.tick({...options,...changes},clock.last+1000) || changed; return changed; }
test('按活动时间到期只保留一条，确认后重新计时并轮换文案', () => {
  const clock = new EyeBreak(0); assert.equal(advance(clock,299),false); assert.equal(advance(clock,1),true);
  const first = clock.pending.title; assert.equal(advance(clock,600),false); assert.equal(clock.pending.title,first);
  clock.action('done',clock.last); advance(clock,300); assert.notEqual(clock.pending.title,first);
  for(const line of lines) assert.ok(line.length < 35);
});
test('短闲置和免打扰暂停，长闲置、禁用和休眠时间跳跃重置', () => {
  const clock = new EyeBreak(0); advance(clock,200); advance(clock,100,{idleSeconds:80}); advance(clock,100,{quiet:true});
  assert.equal(clock.elapsed,200000); advance(clock,100); assert.ok(clock.pending);
  advance(clock,1,{idleSeconds:120}); assert.equal(clock.pending,null); assert.equal(clock.elapsed,0);
  advance(clock,100); clock.tick(options,clock.last+60000); assert.equal(clock.elapsed,0);
  clock.show(); advance(clock,1,{enabled:false}); assert.equal(clock.pending,null);
});
test('稍后提醒在继续使用五分钟后触发，非法操作拒绝', () => {
  const clock = new EyeBreak(0); clock.show(); clock.action('snooze',0);
  advance(clock,299,{minutes:60}); assert.equal(clock.pending,null); advance(clock,1,{minutes:60}); assert.ok(clock.pending);
  assert.throws(()=>clock.action('bad'));
});
test('旧状态兼容默认30分钟，开关和自定义间隔通过状态校验', () => {
  const old = defaults(); delete old.settings.eyeBreak; delete old.settings.eyeMinutes;
  assert.equal(validateState(old).settings.eyeMinutes,30); assert.equal(validateState(old).settings.eyeBreak,true);
  old.settings.eyeBreak=false; old.settings.eyeMinutes=75; assert.equal(validateState(old).settings.eyeMinutes,75); assert.equal(validateState(old).settings.eyeBreak,false);
  old.settings.eyeMinutes=-1; assert.equal(validateState(old).settings.eyeMinutes,30);
});
