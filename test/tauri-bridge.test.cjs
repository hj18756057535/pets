const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('Tauri bridge keeps the existing page contract and forwards events', async () => {
  const calls = []; const listeners = new Map();
  const window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push({ command, args }); return args.input; } },
    event: { listen: async (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name); } }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/tauri-bridge.js'), 'utf8'), { window });
  const api = window.petdesk;
  assert.ok(api);
  await api.addReminder({ title: '例会' });
  await api.hitTest(true);
  assert.deepEqual(calls.map(c => [c.command, c.args.channel]), [['petdesk_call', 'add-reminder'], ['petdesk_call', 'hit-test']]);
  assert.equal(calls[0].args.input.title, '例会');
  let received;
  const stop = api.onState(value => { received = value; });
  await Promise.resolve();
  listeners.get('state')({ payload: { reminders: [] } });
  assert.equal(received.reminders.length, 0);
  stop();
  assert.equal(listeners.has('state'), false);
});

test('Rust string errors become visible JavaScript Error messages', async () => {
  const window = { __TAURI__: { core: { invoke: async () => { throw '会议名称不能为空'; } }, event: { listen: async () => () => {} } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/tauri-bridge.js'), 'utf8'), { window });
  await assert.rejects(window.petdesk.addReminder({}), error => error.message === '会议名称不能为空');
});
