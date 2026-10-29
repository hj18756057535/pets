import {setupWorkbench} from '../../ui/workbench.mjs';
import {localDate, shiftDate} from '../../ui/workbench-model.mjs';
import {setupDateTimePickers} from '../../ui/date-time-picker.mjs';
// Memory-only adapter: the Demo uses the real workbench view without IPC or file writes.
const anchor = localDate(), categories = ['工作', '学习', '日常'];
let shortcuts = [
  {id: 'note-work', title: '工作知识库', kind: 'obsidian', target: 'obsidian://open?vault=Work&file=首页', description: '项目资料、工作记录与复盘。', pinned: true},
  {id: 'note-personal', title: '个人知识库', kind: 'obsidian', target: 'obsidian://open?vault=Personal&file=首页', description: '学习、思考，以及积累的经验。', pinned: true},
  {id: 'note-design', title: '架构与设计', kind: 'obsidian', target: 'obsidian://search?vault=Work&query=架构', description: '查找架构相关积累。', pinned: true},
];
let tasks = [
  {id: 'task-1', title: '梳理项目报告的待确认问题', date: anchor, time: '09:30', category: '工作', important: true, done: false, note: '把需要讨论的边界整理清楚，留给下一次评审。', shortcutIds: ['note-work', 'note-design']},
  {id: 'task-2', title: '跟进应用接入的联调反馈', date: anchor, time: '14:00', category: '工作', important: false, done: false, note: '', shortcutIds: []},
  {id: 'task-3', title: '整理 Agent 工具调用的实践笔记', date: anchor, time: '16:00', category: '学习', important: false, done: false, note: '', shortcutIds: ['note-personal']},
  {id: 'task-4', title: '把今天的排查结论记到知识库', date: anchor, time: '', category: '日常', important: false, done: false, note: '', shortcutIds: []},
  {id: 'task-5', title: '核对本周需要推进的事项', date: anchor, time: '09:00', category: '工作', important: false, done: true, note: '', shortcutIds: []},
  {id: 'task-6', title: '阅读一篇架构设计笔记', date: anchor, time: '', category: '学习', important: false, done: true, note: '', shortcutIds: ['note-design']},
  {id: 'task-7', title: '准备项目方案讨论的问题清单', date: shiftDate(anchor, 1), time: '10:00', category: '工作', important: true, done: false, note: '', shortcutIds: ['note-work']},
];
let sequence = 10;
const copy = value => structuredClone(value);
const metadata = () => ({categories: copy(categories), shortcuts: copy(shortcuts.filter(item => !item.deleted)), warnings: []});
const api = {
  async workbenchLoad(date) {
    const current = tasks.filter(item => item.date === localDate() && !item.deleted);
    return {...metadata(), month: date.slice(0, 7), tasks: copy(tasks.filter(item => item.date.startsWith(date.slice(0, 7)) && !item.deleted)), today: {total: current.length, done: current.filter(item => item.done).length}};
  },
  async workbenchLoadKnowledge() { return metadata(); },
  async workbenchSaveTask(input) {
    const old = tasks.find(item => item.id === input.id), category = input.category.trim();
    const known = categories.find(value => value.toLowerCase() === category.toLowerCase());
    if (!known) categories.push(category);
    const item = {...old, ...copy(input), id: old?.id || 'task-' + (++sequence), category: known || category, shortcutIds: input.shortcutIds || old?.shortcutIds || [], done: old?.done || false};
    tasks = [...tasks.filter(value => value.id !== item.id), item]; return copy(item);
  },
  async workbenchTaskAction({id, action}) {
    const item = tasks.find(value => value.id === id);
    if (['remove', 'restore'].includes(action)) item.deleted = action === 'remove';
    else item.done = action === 'complete';
    return copy(item);
  },
  async workbenchSaveShortcut(input) {
    const item = {...copy(input), id: input.id || 'note-' + (++sequence)};
    shortcuts = [...shortcuts.filter(value => value.id !== item.id), item]; return copy(item);
  },
  async workbenchShortcutAction({id, action}) {
    const item = shortcuts.find(value => value.id === id);
    if (action === 'pin') item.pinned = !item.pinned; else item.deleted = action === 'remove';
  },
  async workbenchOpenShortcut() { throw new Error('Demo 仅演示入口关联；正式应用会交给本机工具打开。'); },
  async workbenchPickTarget() { throw new Error('Demo 中请粘贴位置；正式应用会弹出本机选择窗口。'); },
};
const $demo = id => document.getElementById('demo-' + id);
let demoMeetingCount = 0, meetingPickers;
const workbenchDemo = setupWorkbench(api, navigateDemo, draft => {
  $demo('meeting-form').reset(); $demo('meeting-title').value = draft.title;
  meetingPickers.set($demo('meeting-date'), draft.date); meetingPickers.set($demo('meeting-time'), draft.time);
  $demo('meeting-result').textContent = draft.time ? '确认日期与时间后模拟创建。' : '待办没有时间，请选择会议开始时间。';
  $demo('meeting-save').disabled = false; $demo('meeting-dialog').showModal();
});
meetingPickers = setupDateTimePickers($demo('meeting-dialog'));
function navigateDemo(name) {
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== name; });
  document.querySelectorAll('[data-demo-tab]').forEach(button => button.classList.toggle('active', button.dataset.demoTab === name));
  document.getElementById('page-title').textContent = name === 'knowledge' ? '让积累，随手可达。' : '今天，也一起好好工作。';
  workbenchDemo.show(name);
}
document.querySelectorAll('[data-demo-tab]').forEach(button => button.addEventListener('click', () => navigateDemo(button.dataset.demoTab)));
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigateDemo('workbench'); });
document.getElementById('calendar-heading').textContent = new Date().toLocaleDateString('zh-CN', {month: 'long', day: 'numeric', weekday: 'long'});
document.querySelector('.demo-footer > span').textContent = '示例数据 · 刷新后恢复 Demo · 不写入应用记录';
$demo('meeting-close').addEventListener('click', () => $demo('meeting-dialog').close());
$demo('meeting-form').addEventListener('submit', event => {
  event.preventDefault();
  if (Array.from($demo('meeting-title').value).length > 100) { $demo('meeting-result').textContent = '会议标题最多 100 字，请缩短标题。'; return; }
  const when = new Date($demo('meeting-date').value + 'T' + $demo('meeting-time').value + ':00');
  if (!Number.isFinite(when.getTime()) || when <= new Date()) { $demo('meeting-result').textContent = '请选择未来的会议时间。'; return; }
  $demo('meeting-result').textContent = '已模拟创建「' + $demo('meeting-title').value + '」；本次共 ' + (++demoMeetingCount) + ' 条演示提醒。';
  $demo('meeting-save').disabled = true;
});
navigateDemo('workbench');
