import {markup, sidebarMarkup, icon, escapeHTML as esc} from './workbench-view.mjs';
import {localDate, validDate, shiftDate, obsidianUrl, webUrl, linkedShortcuts, reminderDraft} from './workbench-model.mjs';
import {setupDateTimePickers} from './date-time-picker.mjs';
import {setupCategoryPickers} from './category-picker.mjs';

export function setupWorkbench(api, navigate, createMeeting) {
  document.querySelector('main').insertAdjacentHTML('beforeend', markup);
  document.querySelector('.sidebar-note').insertAdjacentHTML('beforebegin', sidebarMarkup);
  const root = document.getElementById('work-root');
  const $ = id => document.getElementById(({ 'today-page': 'workbench', 'knowledge-page': 'knowledge' })[id] || 'work-' + id);
  document.querySelectorAll('[data-work-icon]').forEach(el => { el.innerHTML = icon(el.dataset.workIcon); });
  const header = document.querySelector('main > header');
  header.firstElementChild.insertAdjacentHTML('beforeend', '<p id="work-page-description" class="header-description" hidden></p>');
  const pickers = setupDateTimePickers(root);
  const state = {date: localDate(), page: 'workbench', filter: 'all', kind: 'all', query: '', resource: null, ready: false, loading: false, busy: false, active: false, taskLinks: [], shortcutForTask: false};
  let data = {tasks: [], shortcuts: [], categories: ['工作', '学习', '日常'], today: {total: 0, done: 0}};
  const categories = setupCategoryPickers(root, () => data.categories);
  let request = 0, toastTimer, undo, lastDay = localDate();

  function toast(message, action) {
    clearTimeout(toastTimer);
    $('toast-text').textContent = message;
    $('toast-undo').hidden = !action;
    undo = action;
    $('demo-toast').hidden = false;
    toastTimer = setTimeout(() => { $('demo-toast').hidden = true; undo = null; }, action ? 7000 : 4500);
  }
  function showError(id, error) { $(id).textContent = error.message; $(id).hidden = false; }
  function status(message, error = false) {
    $('load-state').hidden = !message;
    $('load-message').textContent = message;
    $('load-state').classList.toggle('is-error', error);
    $('load-state').querySelector('button').hidden = !error;
  }
  function empty(title, copy, symbol = 'sprout') {
    return `<div class="empty-state">${icon(symbol)}<strong>${esc(title)}</strong><p>${esc(copy)}</p></div>`;
  }
  const typeName = kind => ({obsidian: 'Obsidian', file: '本机文件', web: '网页'}[kind]);
  const typeIcon = kind => ({obsidian: 'obsidian', file: 'folder', web: 'globe'}[kind]);
  const openAttrs = item => `href="#" data-work-open="${esc(item.id)}"`;
  function locationText(item) {
    if (item.kind === 'web') { try { return new URL(item.target).hostname; } catch { return item.target; } }
    if (item.target.startsWith('obsidian:')) {
      const url = new URL(item.target), params = url.searchParams;
      if (url.hostname === 'search') return `${params.get('vault')} / 搜索「${params.get('query') || ''}」`;
      return params.get('path') || `${params.get('vault')} / ${params.get('file') || '知识库'}`;
    }
    return item.target;
  }
  function taskRow(task) {
    const links = linkedShortcuts(task.shortcutIds, data.shortcuts).map(item => item.missing ? '<span class="task-resource-link is-missing">入口已移除</span>' : `<a class="task-resource-link" ${openAttrs(item)}>${icon('book-open')}${esc(item.title)}${icon('external')}</a>`).join('');
    return `<div class="task-row ${task.done ? 'is-done' : ''}"><label class="task-check"><input type="checkbox" data-work-task-check="${task.id}" aria-label="${task.done ? '重新打开' : '完成'}：${esc(task.title)}" ${task.done ? 'checked' : ''}><span>${icon('check')}</span></label><div class="task-copy"><button class="task-title" type="button" data-work-edit-task="${task.id}">${esc(task.title)}</button><div class="task-meta"><span class="category ${task.category === '学习' ? 'learning' : task.category === '日常' ? 'daily' : ''}">${esc(task.category)}</span>${task.time ? `<span>${icon('clock')}${esc(task.time)}</span>` : ''}${task.important && !task.done ? `<span class="important">${icon('flag')}重要</span>` : ''}${task.done ? '<span>已完成</span>' : ''}</div>${task.note ? `<p class="task-note">${esc(task.note)}</p>` : ''}<div class="task-resource-links">${links}<button class="task-meeting-link" type="button" data-work-meeting="${task.id}">${icon('clock')}建会议提醒</button></div></div><button class="icon-button" type="button" data-work-edit-task="${task.id}" aria-label="编辑：${esc(task.title)}">${icon('pencil')}</button></div>`;
  }
  function renderDaily() {
    const tasks = data.tasks.filter(task => task.date === state.date).sort((a, b) => Number(a.done) - Number(b.done) || Number(b.important) - Number(a.important) || (a.time || '99:99').localeCompare(b.time || '99:99'));
    const done = tasks.filter(task => task.done), pending = tasks.filter(task => !task.done);
    pickers.set($('selected-date'), state.date);
    $('return-today').disabled = state.date === localDate();
    $('count-all').textContent = tasks.length;
    $('count-todo').textContent = pending.length;
    $('count-done').textContent = done.length;
    root.querySelectorAll('[data-work-filter]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.workFilter === state.filter)));
    $('summary-title').textContent = !tasks.length ? '给这一天，留一点从容。' : pending.length ? `还有 ${pending.length} 件事，按自己的节奏来。` : '安排的事情，都完成啦。';
    $('summary-description').textContent = !tasks.length ? '想好一件要做的事，就从这里记下来。' : done.length ? `已经完成了 ${done.length} 件，每一步都算数。` : '先选一件重要的事，开始就很好。';
    $('progress-label').textContent = `${done.length} / ${tasks.length}`;
    $('day-progress').max = Math.max(1, tasks.length);
    $('day-progress').value = done.length;
    const sections = [];
    if (state.filter !== 'done' && pending.length) sections.push(`<div class="task-group-label">待完成 <span>${pending.length}</span></div>${pending.map(taskRow).join('')}`);
    if (state.filter !== 'todo' && done.length) sections.push(`<div class="task-group-label">已完成 <span>${done.length}</span></div>${done.map(taskRow).join('')}`);
    $('task-list').innerHTML = !state.ready ? empty(state.loading ? '正在读取记录…' : '暂时无法读取记录', state.loading ? '稍等一下，你的安排马上就来。' : '请点击上方“重试”，原有数据不会被替换。') : sections.join('') || empty(!tasks.length ? '这天还没有安排' : state.filter === 'todo' ? '要做的事都完成了' : '还没有已完成的事项', !tasks.length ? '在上方记下一件小事，或点击“新增待办”。' : state.filter === 'todo' ? '休息一下，也可以看看常用知识。' : '完成一件事，就会出现在这里。');
    $('list-footnote').textContent = `${tasks.length ? `当天共 ${tasks.length} 件事 · ` : ''}每次完成，都算一个小进展。`;
    $('nav-count').textContent = Math.max(0, data.today.total - data.today.done);
    $('nav-count').hidden = !data.month;
    $('sidebar-progress-card').hidden = !state.active || !data.month;
    $('sidebar-progress').textContent = data.today.total ? `完成了 ${data.today.done} 件事` : '今天从一件事开始';
    $('progress-dots').innerHTML = Array.from({length: Math.min(data.today.total || 6, 12)}, (_, i) => `<i class="${i < data.today.done ? 'done' : ''}"></i>`).join('');
    $('pinned-shortcuts').innerHTML = data.shortcuts.filter(item => item.pinned).map(item => `<a class="pinned-shortcut" ${openAttrs(item)}><span class="shortcut-symbol ${item.kind}">${icon(typeIcon(item.kind))}</span><span class="pinned-copy"><span class="pinned-title">${esc(item.title)}</span><span class="pinned-subtitle">${typeName(item.kind)}</span></span>${icon('external')}</a>`).join('') || '<p class="card-description">把常用的入口固定到这里。</p>';
  }
  function renderKnowledge() {
    const query = state.query.toLocaleLowerCase();
    const items = data.shortcuts.filter(item => (state.kind === 'all' || item.kind === state.kind) && `${item.title} ${item.description} ${locationText(item)} ${typeName(item.kind)}`.toLocaleLowerCase().includes(query));
    root.querySelectorAll('[data-work-kind]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.workKind === state.kind)));
    $('shortcut-count').textContent = `${items.length} 个入口`;
    $('shortcut-grid').innerHTML = items.map(item => `<article class="shortcut-card"><div class="shortcut-card-top"><span class="shortcut-symbol ${item.kind}">${icon(typeIcon(item.kind))}</span><button type="button" class="icon-button pin-button" data-work-pin="${item.id}" aria-label="${item.pinned ? '取消固定' : '固定到每日待办'}：${esc(item.title)}" aria-pressed="${item.pinned}">${icon('pin')}</button></div><h2>${esc(item.title)}</h2><p class="shortcut-card-description">${esc(item.description || '随手打开，接着积累。')}</p><p class="shortcut-location">${esc(locationText(item))}</p><div class="shortcut-card-bottom"><a class="open-shortcut" ${openAttrs(item)}>${item.kind === 'obsidian' ? '在 Obsidian 打开' : item.kind === 'web' ? '在浏览器打开' : '用默认应用打开'}${icon('external')}</a><button type="button" class="icon-button" data-work-details="${item.id}" aria-label="${esc(item.title)}的更多操作">${icon('more')}</button></div></article>`).join('') || empty(query || state.kind !== 'all' ? '没有找到相关入口' : '把常用的知识，放到手边。', query || state.kind !== 'all' ? '换一个关键词或筛选条件试试。' : '添加一个 Obsidian 笔记、资料文件夹或网页。', 'book-open');
  }
  function renderAll() {
    renderDaily(); renderKnowledge();
    categories.sync();
    if ($('task-dialog').open) renderTaskKnowledge();
  }
  function renderTaskKnowledge() {
    const query = $('task-knowledge-search').value.trim().toLocaleLowerCase();
    $('task-linked').innerHTML = linkedShortcuts(state.taskLinks, data.shortcuts).map(item => `<span class="linked-chip ${item.missing ? 'is-missing' : ''}"><span>${esc(item.title)}</span><button type="button" data-work-unlink="${esc(item.id)}" aria-label="解除关联：${esc(item.title)}">${icon('x')}</button></span>`).join('');
    const items = data.shortcuts.filter(item => `${item.title} ${item.description}`.toLocaleLowerCase().includes(query));
    $('task-knowledge-options').innerHTML = items.map(item => `<label class="knowledge-choice"><input type="checkbox" data-work-link="${esc(item.id)}" ${state.taskLinks.includes(item.id) ? 'checked' : ''}><span>${esc(item.title)}<small>${typeName(item.kind)}</small></span></label>`).join('') || `<p class="input-help">${query ? '没有找到入口，试试其他关键词。' : '还没有知识入口，可以新建并关联。'}</p>`;
  }
  async function refresh(day = state.date) {
    const version = ++request;
    state.date = day; state.loading = true; state.ready = false;
    root.setAttribute('aria-busy', 'true'); status('正在读取本地记录…'); renderDaily();
    try {
      const snapshot = state.page === 'knowledge' ? await api.workbenchLoadKnowledge() : await api.workbenchLoad(day);
      if (version !== request) return false;
      data = {...data, ...snapshot}; state.ready = true;
      status(snapshot.warnings.join('；'));
      renderAll(); return true;
    } catch (error) {
      if (version === request) { state.ready = false; state.loading = false; status(error.message, true); renderDaily(); }
      return false;
    } finally {
      if (version === request) { state.loading = false; root.setAttribute('aria-busy', 'false'); }
    }
  }
  async function mutate(operation, errorId) {
    if (state.busy || !state.ready) return;
    state.busy = true; categories.close();
    const controls = [...root.querySelectorAll('button, input, textarea, select')].map(el => [el, el.disabled]);
    controls.forEach(([el]) => { el.disabled = true; });
    try { await operation(); }
    catch (error) { if (errorId) showError(errorId, error); else toast(error.message); }
    finally { controls.forEach(([el, disabled]) => { if (el.isConnected) el.disabled = disabled; }); state.busy = false; $('return-today').disabled = state.date === localDate(); }
  }
  function showTask(id) {
    const task = data.tasks.find(item => item.id === id), form = $('task-form');
    form.reset(); form.elements.id.value = task?.id || ''; form.elements.title.value = task?.title || '';
    form.elements.category.value = task?.category || $('quick-category').value || '工作';
    form.elements.note.value = task?.note || ''; form.elements.important.checked = Boolean(task?.important);
    state.taskLinks = [...(task?.shortcutIds || [])]; $('task-knowledge-search').value = ''; renderTaskKnowledge(); categories.close();
    pickers.set($('task-date'), task?.date || state.date); pickers.set($('task-time'), task?.time || '');
    $('task-dialog-title').textContent = task ? '这件事，接着处理。' : '安排一件事';
    $('delete-task').hidden = !task; $('task-error').hidden = true; $('task-dialog').showModal(); $('task-title').focus();
  }
  function shortcutHelp() {
    const kind = $('shortcut-kind').value;
    $('shortcut-target-label').textContent = kind === 'obsidian' ? '笔记路径或 Obsidian 链接 *' : kind === 'file' ? '文件或文件夹完整路径 *' : '网页地址 *';
    $('shortcut-target').placeholder = kind === 'obsidian' ? 'obsidian://open?vault=…&file=…' : kind === 'file' ? '选择资料文件或文件夹' : 'https://…';
    $('shortcut-help').textContent = kind === 'obsidian' ? '选择已加入 Obsidian 知识库的笔记，或粘贴“复制 Obsidian URL”得到的链接。' : kind === 'file' ? '用本机默认应用或资源管理器打开，原资料继续在原位置维护。' : '由系统默认浏览器打开原网页。';
    root.querySelectorAll('[data-work-pick]').forEach(el => { el.hidden = kind === 'web' || (kind === 'obsidian' && el.dataset.workPick === 'folder'); });
  }
  function showShortcut(id, forTask = false) {
    const item = data.shortcuts.find(item => item.id === id), form = $('shortcut-form');
    form.reset(); form.elements.id.value = item?.id || ''; form.elements.title.value = item?.title || '';
    form.elements.kind.value = item?.kind || 'obsidian'; form.elements.target.value = item?.target || '';
    form.elements.description.value = item?.description || ''; form.elements.pinned.checked = item ? item.pinned : true;
    state.shortcutForTask = forTask;
    $('shortcut-dialog-title').textContent = forTask ? '新建知识入口并关联' : item ? '编辑知识入口' : '添加知识入口';
    categories.close();
    $('shortcut-error').hidden = true; shortcutHelp(); $('shortcut-dialog').showModal(); $('shortcut-title').focus();
  }
  function showResource(id) {
    const item = data.shortcuts.find(item => item.id === id); if (!item) return;
    state.resource = id; $('resource-dialog-title').textContent = item.title;
    $('resource-description').textContent = item.description || '回到原来的位置，继续阅读和整理。';
    $('resource-target').value = item.target; $('copy-target').innerHTML = icon('copy') + '复制地址';
    $('resource-note').textContent = item.kind === 'obsidian' ? '交给本机 Obsidian 打开，请确保应用已安装并已加入对应知识库。' : '交给系统默认应用打开，原资料继续在原位置维护。';
    $('resource-open').hidden = false; $('resource-open').href = '#'; $('resource-open').dataset.workOpen = item.id;
    $('resource-open').innerHTML = `${item.kind === 'obsidian' ? '在 Obsidian 打开' : item.kind === 'web' ? '在浏览器打开' : '用默认应用打开'}${icon('external')}`;
    $('resource-dialog').showModal();
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button, a'); if (!button) return;
    if (button.getAttribute('href') === '#knowledge') { event.preventDefault(); navigate('knowledge'); return; }
    if (button.dataset.workAction === 'reload') { void refresh(); return; }
    if (button.hasAttribute('data-work-close') && !state.busy) { button.closest('dialog').close(); return; }
    if (!state.ready || state.busy) { event.preventDefault(); return; }
    if (button.dataset.workAction === 'new-task') { showTask(); return; }
    if (button.dataset.workAction === 'new-shortcut') { showShortcut(); return; }
    if (button.dataset.workAction === 'new-linked-shortcut') {
      if (state.taskLinks.length >= 20) { showError('task-error', new Error('每条待办最多关联 20 个知识入口')); return; }
      showShortcut(null, true); return;
    }
    if (button.dataset.workUnlink) { state.taskLinks = state.taskLinks.filter(id => id !== button.dataset.workUnlink); renderTaskKnowledge(); return; }
    if (button.dataset.workMeeting) { const task = data.tasks.find(item => item.id === button.dataset.workMeeting); if (task) createMeeting(reminderDraft(task)); return; }
    if (button.dataset.workAction === 'clear-time') { pickers.clear($('task-time')); return; }
    if (button.dataset.workEditTask) { showTask(button.dataset.workEditTask); return; }
    if (button.dataset.workShift) { void refresh(shiftDate(state.date, Number(button.dataset.workShift))); return; }
    if (button.dataset.workFilter) { state.filter = button.dataset.workFilter; renderDaily(); return; }
    if (button.dataset.workKind) { state.kind = button.dataset.workKind; renderKnowledge(); return; }
    if (button.dataset.workDetails) { showResource(button.dataset.workDetails); return; }
    if (button.dataset.workPin) {
      const id = button.dataset.workPin;
      void mutate(async () => { await api.workbenchShortcutAction({id, action: 'pin'}); await refresh(); root.querySelector(`[data-work-pin="${id}"]`)?.focus(); }); return;
    }
    if (button.dataset.workOpen) {
      event.preventDefault(); const id = button.dataset.workOpen;
      void mutate(async () => { await api.workbenchOpenShortcut(id); toast('已交给本机应用打开'); }); return;
    }
    if (button.dataset.workPick) {
      void mutate(async () => {
        const kind = $('shortcut-kind').value === 'obsidian' ? 'obsidian' : button.dataset.workPick;
        const path = await api.workbenchPickTarget(kind); if (path) $('shortcut-target').value = path;
      }, 'shortcut-error');
    }
  });
  $('task-list').addEventListener('change', event => {
    const id = event.target.dataset.workTaskCheck; if (!id) return;
    const task = data.tasks.find(task => task.id === id); if (!task) return;
    if (state.busy || !state.ready) { event.target.checked = task.done; return; }
    void mutate(async () => {
      try {
        await api.workbenchTaskAction({id, date: task.date, action: task.done ? 'reopen' : 'complete'}); await refresh();
        (root.querySelector(`[data-work-task-check="${id}"]`) || root.querySelector('[data-work-task-check]') || root.querySelector('[data-work-filter]'))?.focus();
      }
      finally { renderDaily(); }
    });
  });
  $('selected-date').addEventListener('change', event => { if (!state.busy && validDate(event.target.value)) void refresh(event.target.value); });
  $('return-today').addEventListener('click', () => { if (!state.busy) void refresh(localDate()); });
  $('quick-task-form').addEventListener('submit', event => {
    event.preventDefault(); const input = $('quick-title'), title = input.value.trim(), category = $('quick-category').value.trim();
    if (!title || !category) { toast('请填写待办名称和分类'); return; }
    void mutate(async () => {
      await api.workbenchSaveTask({title, date: state.date, category});
      input.value = ''; state.filter = 'all'; await refresh(); input.focus(); toast('记下了，按自己的节奏来。');
    });
  });
  $('task-form').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    const meeting = event.submitter?.value === 'meeting';
    const id = form.elements.id.value, old = data.tasks.find(task => task.id === id);
    const input = {id: id || null, originalDate: old?.date || null, title: form.elements.title.value.trim(), date: form.elements.date.value, time: form.elements.time.value, category: form.elements.category.value.trim(), important: form.elements.important.checked, note: form.elements.note.value.trim(), shortcutIds: [...state.taskLinks]};
    if (!input.title || !input.category || !validDate(input.date)) { showError('task-error', new Error('请填写待办名称、有效日期和分类')); return; }
    void mutate(async () => {
      const saved = await api.workbenchSaveTask(input); $('task-dialog').close(); state.filter = 'all'; await refresh(saved.date);
      if (meeting) createMeeting(reminderDraft(saved)); else toast('待办已保存');
    }, 'task-error');
  });
  $('delete-task').addEventListener('click', () => {
    const id = $('task-form').elements.id.value, task = data.tasks.find(task => task.id === id); if (!task) return;
    void mutate(async () => {
      await api.workbenchTaskAction({id, date: task.date, action: 'remove'}); $('task-dialog').close(); await refresh();
      toast('已移除待办', () => mutate(async () => { await api.workbenchTaskAction({id, date: task.date, action: 'restore'}); await refresh(); toast('已恢复待办'); }));
    }, 'task-error');
  });
  $('shortcut-kind').addEventListener('change', shortcutHelp);
  $('task-knowledge-search').addEventListener('input', renderTaskKnowledge);
  $('task-knowledge-options').addEventListener('change', event => {
    const id = event.target.dataset.workLink; if (!id || state.busy) return;
    if (event.target.checked && !state.taskLinks.includes(id)) {
      if (state.taskLinks.length >= 20) { event.target.checked = false; showError('task-error', new Error('每条待办最多关联 20 个知识入口')); return; }
      state.taskLinks.push(id);
    } else state.taskLinks = state.taskLinks.filter(key => key !== id);
    renderTaskKnowledge();
  });
  $('shortcut-form').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget;
    const input = {id: form.elements.id.value || null, title: form.elements.title.value.trim(), kind: form.elements.kind.value, target: form.elements.target.value.trim(), description: form.elements.description.value.trim(), pinned: form.elements.pinned.checked};
    try {
      if (!input.title || !input.target) throw new Error('请填写入口名称和原始位置');
      if (input.kind === 'obsidian') obsidianUrl(input.target); else if (input.kind === 'web') webUrl(input.target);
    } catch (error) { showError('shortcut-error', error); return; }
    const forTask = state.shortcutForTask;
    void mutate(async () => {
      const saved = await api.workbenchSaveShortcut(input); $('shortcut-dialog').close();
      if (forTask && !state.taskLinks.includes(saved.id)) state.taskLinks.push(saved.id);
      data.shortcuts = [...data.shortcuts.filter(item => item.id !== saved.id), saved]; renderTaskKnowledge();
      await refresh(); toast(forTask ? '入口已保存，保存待办即可完成关联' : '知识入口已保存');
    }, 'shortcut-error');
  });
  $('shortcut-search').addEventListener('input', event => { state.query = event.target.value.trim(); renderKnowledge(); });
  $('edit-shortcut').addEventListener('click', () => { if (!state.busy) { $('resource-dialog').close(); showShortcut(state.resource); } });
  $('delete-shortcut').addEventListener('click', () => {
    const id = state.resource;
    void mutate(async () => {
      await api.workbenchShortcutAction({id, action: 'remove'}); $('resource-dialog').close(); await refresh();
      toast('已移除入口，原资料不受影响', () => mutate(async () => { await api.workbenchShortcutAction({id, action: 'restore'}); await refresh(); toast('已恢复入口'); }));
    });
  });
  $('copy-target').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('resource-target').value); $('copy-target').innerHTML = icon('check') + '已复制'; }
    catch { $('resource-target').focus(); $('resource-target').select(); $('resource-note').textContent = '地址已选中，请按 Ctrl+C 复制。'; }
  });
  $('toast-undo').addEventListener('click', () => { const action = undo; if (action && !state.busy && state.ready) { undo = null; $('demo-toast').hidden = true; void action(); } });
  root.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog || state.busy) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) {
      event.preventDefault(); navigate('knowledge'); $('shortcut-search').focus();
    }
  });
  function checkDay() {
    if (!state.active || document.hidden || state.busy || root.querySelector('dialog[open]')) return;
    const current = localDate();
    if (current !== lastDay) { if (state.date === lastDay) state.date = current; lastDay = current; void refresh(); }
  }
  document.addEventListener('visibilitychange', checkDay);
  setInterval(checkDay, 60000);
  renderAll();
  return {
    hasOpenDialog() { return Boolean(root.querySelector('dialog[open]')); },
    show(name) {
      state.active = ['workbench', 'knowledge'].includes(name); state.page = name;
      root.hidden = !state.active; $('sidebar-progress-card').hidden = !state.active;
      document.body.classList.toggle('workbench-demo', state.active); header.classList.toggle('workbench-header', state.active);
      $('page-description').hidden = !state.active;
      $('page-description').textContent = name === 'knowledge' ? '把常用入口收好，回到你熟悉的工具里。' : '安排好今天的事，需要的知识也在手边。';
      if (state.active) {
        const current = localDate();
        if (state.date === lastDay) state.date = current;
        lastDay = current;
        void refresh();
      } else { pickers.close(); categories.close(); }
    }
  };
}
