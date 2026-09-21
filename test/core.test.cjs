const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store, makeReminder, dueIds, clampPosition, readPet, webpSize, validateState, defaults, edgeSide, dockBounds, expandedDockPosition } = require('../src/core.cjs');
const testRoot = path.join(__dirname, '..', '.data', 'tests');
test('新用户默认 60%，旧设置和新增迷你尺寸均兼容', () => {
  assert.equal(defaults().settings.scale, 0.6);
  for (const scale of [0.45, 0.6, 0.8, 1, 1.2]) assert.equal(validateState({ ...defaults(), settings: { scale } }).settings.scale, scale);
});
test('只在左右边缘收起，支持负坐标屏幕和边缘容差', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 }, size = { width: 168, height: 180 };
  assert.equal(edgeSide({ x: -1910, y: 100 }, size, area), 'left');
  assert.equal(edgeSide({ x: -170, y: 100 }, size, area), 'right');
  assert.equal(edgeSide({ x: -1000, y: 0 }, size, area), null);
  assert.deepEqual(dockBounds({ side: 'right', y: 9999 }, area), { x: -38, y: 1015, width: 38, height: 65 });
  assert.deepEqual(dockBounds({ side: 'left', y: -99 }, area), { x: -1920, y: 0, width: 38, height: 65 });
});

test('展开保持所在侧边及宠物高度，多种尺寸和负坐标屏幕均不越界', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1080 };
  for (const scale of [.45,.6,1.2]) for (const side of ['left','right']) {
    const size = {width:320,height:Math.ceil(198+156*scale)};
    const p = expandedDockPosition({side,y:400},area,size,scale);
    assert.equal(p.x,side==='left' ? -1920 : -320);
    assert.ok(Math.abs(p.y+190+78*scale-432.5)<=.5);
    for (const y of [-100,10000]) {
      const edge = expandedDockPosition({side,y},area,size,scale);
      assert.ok(edge.y>=0 && edge.y+size.height<=1080);
    }
  }
});
test('收起状态与展开位置持久保存，旧数据没有 dock 字段也能恢复', () => {
  const s = new Store(dir()); s.update(d => { d.dock = { side: 'left', displayId: '123', y: 200 }; d.position = { x: 20, y: 100 }; });
  assert.deepEqual(new Store(s.directory).snapshot(), s.snapshot());
  const old = defaults(); delete old.dock; assert.equal(validateState(old).dock, null);
});
fs.mkdirSync(testRoot, { recursive: true });
function dir() { return fs.mkdtempSync(path.join(testRoot, 'case-')); }
test('提醒时间以 UTC 保存，提前时间已过时立即进入到期检查', () => {
  const now = Date.parse('2026-09-19T10:00:00+08:00');
  const r = makeReminder({ title: '  会议  ', meetingAt: '2026-09-19T10:03:00+08:00', leadMinutes: 5 }, now);
  assert.equal(r.title, '会议'); assert.equal(r.meetingAt, '2026-09-19T02:03:00.000Z'); assert.deepEqual(dueIds([r], now), [r.id]);
});
test('拒绝无效时间、过期时间、超长标题和越界提前量', () => {
  const now = Date.now(); const base = { title: '例会', meetingAt: new Date(now + 60000).toISOString(), leadMinutes: 0 };
  for (const input of [{ ...base, title: '' }, { ...base, title: 'x'.repeat(101) }, { ...base, meetingAt: 'invalid' }, { ...base, meetingAt: new Date(now - 1).toISOString() }, { ...base, leadMinutes: -1 }, { ...base, leadMinutes: 1.5 }]) assert.throws(() => makeReminder(input, now));
});
test('唤醒或重启后一次收集全部逾期项，已激活与已完成项不重复触发', () => {
  const now = Date.now(); const r = makeReminder({ title: '会议', meetingAt: new Date(now + 1000).toISOString() }, now);
  assert.deepEqual(dueIds([r], now), []);
  assert.deepEqual(dueIds([r, { ...r, id: 'active', status: 'active' }, { ...r, id: 'done', status: 'done' }], now + 86400000), [r.id]);
});
test('设置、提醒、已确认状态在重新打开 Store 后保留', () => {
  const directory = dir(); const s = new Store(directory); const r = makeReminder({ title: '项目会议', meetingAt: new Date(Date.now() + 10000).toISOString() });
  s.update(d => { d.reminders.push(r); d.settings.quiet = true; d.position = { x: -100, y: 200 }; });
  const restored = new Store(directory); assert.deepEqual(restored.snapshot(), s.snapshot());
  restored.update(d => { d.reminders[0].status = 'done'; });
  assert.equal(new Store(directory).state.reminders[0].status, 'done');
});
test('状态文件损坏时保留原件并从有效备份恢复', () => {
  const directory = dir(); const s = new Store(directory); s.update(d => { d.settings.quiet = true; }); s.update(d => { d.settings.sound = true; });
  fs.writeFileSync(s.file, '{broken');
  const recovered = new Store(directory); assert.equal(recovered.state.settings.quiet, true); assert.match(recovered.warning, /备份/); assert.ok(fs.readdirSync(directory).some(f => f.startsWith('state.corrupt-')));
  recovered.update(d => { d.settings.sound = false; }); assert.equal(new Store(directory).state.settings.quiet, true);
});
test('磁盘写入失败不改变内存中的提醒状态', () => {
  const directory = dir(); const s = new Store(directory); s.update(() => {}); const before = s.snapshot(); fs.mkdirSync(`${s.file}.tmp`);
  assert.throws(() => s.update(d => { d.settings.quiet = true; })); assert.deepEqual(s.snapshot(), before);
});
test('拒绝重复提醒 ID 和损坏记录，防止更新错误的会议', () => {
  const data = defaults(); const r = makeReminder({ title: '重复', meetingAt: new Date(Date.now() + 10000).toISOString() });
  data.reminders = [r, { ...r }]; assert.throws(() => validateState(data));
  data.reminders = [{ ...r, status: 'unknown' }]; assert.throws(() => validateState(data));
});
test('显示器断开后移回可见区域，支持负坐标副屏', () => {
  const size = { width: 280, height: 300 }; const main = { x: 0, y: 0, width: 1920, height: 1040 }; const left = { x: -1280, y: 0, width: 1280, height: 720 };
  assert.deepEqual(clampPosition({ x: -1000, y: 100 }, size, [main, left]), { x: -1000, y: 100 });
  assert.deepEqual(clampPosition({ x: -1000, y: 100 }, size, [main]), { x: 0, y: 100 });
  assert.deepEqual(clampPosition({ x: 9999, y: 9999 }, size, [main]), { x: 1640, y: 740 });
});
test('拒绝宠物包路径穿越和版本尺寸不匹配', () => {
  const directory = dir(); fs.writeFileSync(path.join(directory, 'pet.json'), JSON.stringify({ spritesheetPath: '../secret.webp' }));
  assert.throws(() => readPet(directory), /目录内/);
  const bytes = Buffer.alloc(30); bytes.write('RIFF'); bytes.write('WEBP', 8); bytes.write('VP8X', 12); bytes.writeUInt32LE(10, 16); bytes.writeUIntLE(1535, 24, 3); bytes.writeUIntLE(1871, 27, 3);
  assert.deepEqual(webpSize(bytes), { width: 1536, height: 1872 });
  fs.writeFileSync(path.join(directory, 'spritesheet.webp'), bytes); fs.writeFileSync(path.join(directory, 'pet.json'), JSON.stringify({ spriteVersionNumber: 2 }));
  assert.throws(() => readPet(directory), /版本与尺寸/);
});
