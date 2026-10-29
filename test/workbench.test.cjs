const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('workbench bridge keeps task dates, custom categories and native-open identifiers', async () => {
  const calls = [];
  const window = {__TAURI__: {core: {invoke: async (command, args) => { calls.push({command, ...args}); }}, event: {listen: async () => () => {}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/tauri-bridge.js'), 'utf8'), {window});
  const api = window.petdesk;
  await api.workbenchLoad('2026-11-01');
  await api.workbenchLoadKnowledge();
  await api.workbenchSaveTask({id: 'test', originalDate: '2026-10-31', date: '2026-11-01', category: '架构评审', title: '测试', shortcutIds: ['note']});
  await api.workbenchTaskAction({id: 'test', date: '2026-11-01', action: 'restore'});
  await api.workbenchSaveShortcut({kind: 'obsidian', target: 'obsidian://open?vault=Work'});
  await api.workbenchShortcutAction({id: 'note', action: 'pin'});
  await api.workbenchOpenShortcut('note');
  await api.workbenchPickTarget('folder');
  assert(calls.every(call => call.command === 'petdesk_call'));
  assert.deepEqual(calls.map(call => call.channel), ['workbench-load', 'workbench-load-knowledge', 'workbench-save-task', 'workbench-task-action', 'workbench-save-shortcut', 'workbench-shortcut-action', 'workbench-open-shortcut', 'workbench-pick-target']);
  assert.equal(calls[2].input.originalDate, '2026-10-31');
  assert.equal(calls[2].input.category, '架构评审');
  assert.deepEqual(calls[2].input.shortcutIds, ['note']);
  assert.deepEqual(Object.keys(calls[6].input), ['id']);
  assert.equal(calls[7].input.kind, 'folder');
});

test('calendar boundaries and read-only Obsidian links support Unicode and Windows paths', async () => {
  const {validDate, shiftDate, obsidianUrl, webUrl, localDate} = await import('../ui/workbench-model.mjs');
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  assert.equal(localDate(new Date(2026, 9, 28, 23, 59)), '2026-10-28');
  const target = 'D:\\knowledge\\Personal\\中文 & 笔记.md';
  assert.equal(new URL(obsidianUrl(target)).searchParams.get('path'), target);
  assert.throws(() => obsidianUrl('obsidian://new?vault=Work&name=test'));
  assert.throws(() => obsidianUrl('obsidian://open?vault=Work&append=test'));
  assert.throws(() => webUrl('javascript:alert(1)'));
});

test('user-provided titles and custom category names cannot inject markup', async () => {
  const {escapeHTML} = await import('../ui/workbench-view.mjs');
  assert.equal(escapeHTML('<img src=x onerror="alert(1)"> &'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp;');
  assert.equal(escapeHTML('架构评审'), '架构评审');
});

test('workbench controls have unique identifiers and preserve existing panel labels', async () => {
  const {markup, sidebarMarkup} = await import('../ui/workbench-view.mjs');
  const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8') + markup + sidebarMarkup;
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const match of html.matchAll(/\b(?:for|list|aria-labelledby|aria-describedby|aria-controls)="([^"]+)"/g)) {
    for (const id of match[1].split(/\s+/)) assert(ids.includes(id), 'Missing label target: ' + id);
  }
  assert(!markup.includes('type="date"'));
  assert(!markup.includes('type="time"'));
  assert(!markup.includes('<datalist'));
  assert.equal([...markup.matchAll(/role="combobox"/g)].length, 2);
  const taskForm = /<form id="work-task-form">([\s\S]*?)<\/form>/.exec(markup)[1];
  const firstSubmit = /<button[^>]*type="submit"[^>]*>/.exec(taskForm)[0];
  assert(!firstSubmit.includes('value="meeting"'), 'Enter should save the todo without creating a meeting draft');
  assert(!markup.includes('data-filter='));
  assert(!markup.includes('data-action='));
});

test('category expansion shows all defaults even when an existing category is already filled', async () => {
  const {categoryChoices} = await import('../ui/category-picker.mjs');
  const options = ['工作', '学习', '日常', '架构评审'];
  assert.deepEqual(categoryChoices(options, '学习', true).map(item => item.value), options);
  assert.deepEqual(categoryChoices(options, '学').map(item => item.value), ['学习', '学']);
  assert.deepEqual(categoryChoices(options, '').map(item => item.value), options);
  assert.deepEqual(options, ['工作', '学习', '日常', '架构评审']);
});

test('category free entry offers a trimmed new value and reuses case-insensitive names', async () => {
  const {categoryChoices} = await import('../ui/category-picker.mjs');
  assert.deepEqual(categoryChoices(['工作', 'Ops'], '  ops '), [{value: 'Ops', create: false}]);
  assert.deepEqual(categoryChoices(['工作'], '  调研  '), [{value: '调研', create: true}]);
  assert.deepEqual(categoryChoices(['工作'], ' '), [{value: '工作', create: false}]);
  assert.deepEqual(categoryChoices(['工作'], 'a'.repeat(31)), []);
});

test('todo knowledge links resolve current titles and keep removed entries visibly unavailable', async () => {
  const {linkedShortcuts} = await import('../ui/workbench-model.mjs');
  const entries = [{id: 'a', title: '改名后的笔记'}, {id: 'b', title: '已移除笔记', deleted: true}];
  assert.deepEqual(linkedShortcuts(undefined, entries), []);
  const result = linkedShortcuts(['a', 'b', 'c'], entries);
  assert.equal(result[0].title, '改名后的笔记');
  assert.equal(result[1].missing, true); assert.equal(result[2].missing, true);
  assert(!('target' in result[1])); assert.equal(result[2].id, 'c');
});

test('meeting handoff retains the planned day and leaves an absent time for user confirmation', async () => {
  const {reminderDraft} = await import('../ui/workbench-model.mjs');
  const task = {id: 'task', title: '评审', date: '2026-01-01', time: '09:30', done: true};
  assert.deepEqual(reminderDraft(task), {title: '评审', date: '2026-01-01', time: '09:30'});
  assert.equal(reminderDraft({...task, time: ''}).time, '');
  assert.equal(reminderDraft({...task, title: '长'.repeat(120)}).title.length, 120);
  assert.equal(task.done, true);
});
