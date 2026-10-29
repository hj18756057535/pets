const ICONS = {
  'check-square': '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="m7 12 3 3 7-7"/>',
  book: '<path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1 0-6h13M6 3a3 3 0 0 0-3 3v12"/><path d="M7 7h8M7 10h6"/>',
  'book-open': '<path d="M12 5C9 3 5 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-3-1-7-1-10 1Zm0 0v15"/>',
  sprout: '<path d="M12 21v-9M12 12C4 13 3 8 3 4c7 0 10 2 9 8Zm0 3c0-7 4-9 9-9 0 6-3 9-9 9Z"/>',
  leaf: '<path d="M20 3C9 2 3 6 4 13c1 6 8 8 12 4 3-3 3-8 4-14ZM4 20 15 9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  'chevron-left': '<path d="m14 6-6 6 6 6"/>',
  'chevron-right': '<path d="m10 6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  flag: '<path d="M5 21V4c6-4 8 4 14 0v10c-6 4-8-4-14 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pencil: '<path d="m15 4 5 5M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15l-1 5Z"/>',
  external: '<path d="M14 3h7v7m0-7L11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  obsidian: '<path d="m12 2 7 5 2 10-8 5-10-6L7 5l5-3Z"/><path d="m12 2-2 8 3 12m-3-12 9-3M3 16l7-6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  pin: '<path d="m16 3 5 5-4 1-3 6-5-5 6-3 1-4ZM9 10l-4 4 5 5 4-4M7 17l-5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.book}</svg>`;
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

const categoryControl = (id, value = '') => `<div class="category-picker" data-category-picker><input id="${id}" name="category" value="${value}" maxlength="30" placeholder="选择或输入分类" role="combobox" aria-label="分类，可选择或输入新分类" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-options" autocomplete="off" required><button type="button" data-category-toggle aria-label="展开全部分类" aria-expanded="false" aria-controls="${id}-options"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button><div id="${id}-options" role="listbox" aria-label="已有分类" hidden></div></div>`;

export const markup = `<div id="work-root" hidden><div id="work-load-state" class="work-load-state" role="status" hidden><span id="work-load-message"></span><button type="button" class="secondary" data-work-action="reload">重试</button></div>    <section id="workbench" class="page" hidden aria-label="每日待办">
      <div class="day-toolbar">
        <div class="date-controls">
          <div class="date-switch"><button class="icon-button" type="button" data-work-shift="-1" aria-label="前一天"><span data-work-icon="chevron-left"></span></button><label class="visually-hidden" for="work-selected-date">选择日期</label><input id="work-selected-date" type="text" data-work-picker="date" required><button class="icon-button" type="button" data-work-shift="1" aria-label="后一天"><span data-work-icon="chevron-right"></span></button></div>
          <button class="text-button return-today" id="work-return-today" type="button">回到今天</button>
        </div>
        <button class="primary add-task-button" type="button" data-work-action="new-task"><span data-work-icon="plus"></span>新增待办</button>
      </div>

      <div class="day-summary">
        <div class="summary-symbol" data-work-icon="sprout"></div>
        <div class="summary-copy"><strong id="work-summary-title">今天的安排，慢慢完成。</strong><p id="work-summary-description">先选一件重要的事，开始就很好。</p></div>
        <div class="summary-progress"><div><span>完成进度</span><strong id="work-progress-label">2 / 6</strong></div><progress id="work-day-progress" max="6" value="2" aria-label="当天待办完成进度"></progress></div>
      </div>

      <div class="daily-layout">
        <div class="task-panel">
          <div class="task-panel-toolbar"><div class="task-filters" role="group" aria-label="待办状态筛选"><button type="button" data-work-filter="all" aria-pressed="true">全部 <span id="work-count-all">6</span></button><button type="button" data-work-filter="todo" aria-pressed="false">未完成 <span id="work-count-todo">4</span></button><button type="button" data-work-filter="done" aria-pressed="false">已完成 <span id="work-count-done">2</span></button></div><span class="sort-hint">重要的事放前面</span></div>
          <form id="work-quick-task-form" class="quick-task"><span data-work-icon="plus"></span><label class="visually-hidden" for="work-quick-title">快速添加待办</label><input id="work-quick-title" name="title" maxlength="120" placeholder="记下一件要做的事…" required autocomplete="off">${categoryControl('work-quick-category', '工作')}<button type="submit" aria-label="添加待办"><span data-work-icon="arrow-up"></span></button></form>
          <div id="work-task-list" class="task-list"></div>
          <div class="task-panel-foot"><span data-work-icon="leaf"></span><span id="work-list-footnote">每次完成，都算一个小进展。</span></div>
        </div>

        <aside class="daily-rail" aria-label="常用知识">
          <section class="knowledge-rail-card"><div class="rail-heading"><h2>常用知识</h2><a href="#knowledge" class="subtle-link">全部 <span data-work-icon="arrow-right"></span></a></div><p class="card-description">打开熟悉的工具，接着往下写。</p><div id="work-pinned-shortcuts"></div><button class="add-shortcut-inline" type="button" data-work-action="new-shortcut"><span data-work-icon="plus"></span>添加快捷入口</button></section>
          <div class="gentle-note"><span data-work-icon="book-open"></span><h3>写在熟悉的地方。</h3><p>知识继续留在你的 Obsidian 里，<br>这里帮你少找几步。</p><div class="note-rule"></div><span class="note-caption">积累，一直都在。</span></div>
        </aside>
      </div>
    </section>

    <section id="knowledge" class="page" aria-label="知识快捷入口" hidden>
      <div class="knowledge-toolbar"><div class="shortcut-search"><span data-work-icon="search"></span><label class="visually-hidden" for="work-shortcut-search">搜索知识入口</label><input id="work-shortcut-search" type="search" placeholder="搜索入口名称、标签…" autocomplete="off"><kbd>Ctrl K</kbd></div><button class="primary" type="button" data-work-action="new-shortcut"><span data-work-icon="plus"></span>添加入口</button></div>
      <div class="knowledge-filter-row"><div class="knowledge-filters" role="group" aria-label="知识入口类型"><button type="button" data-work-kind="all" aria-pressed="true">全部</button><button type="button" data-work-kind="obsidian" aria-pressed="false">Obsidian</button><button type="button" data-work-kind="file" aria-pressed="false">文件与文件夹</button><button type="button" data-work-kind="web" aria-pressed="false">网页</button></div><span id="work-shortcut-count" class="muted"></span></div>
      <div id="work-shortcut-grid" class="shortcut-grid"></div>
      <div class="knowledge-bottom-note"><span data-work-icon="external"></span><p>只收好入口。阅读、编辑和整理，继续在你习惯的工具里完成。</p></div>
    </section>

  <dialog id="work-task-dialog" class="editor-dialog" aria-labelledby="work-task-dialog-title">
    <form id="work-task-form">
      <div class="dialog-heading"><div><div class="eyebrow">一天一小步</div><h2 id="work-task-dialog-title">安排一件事</h2></div><button class="icon-button" type="button" data-work-close aria-label="关闭待办编辑"><span data-work-icon="x"></span></button></div>
      <input name="id" type="hidden">
      <label for="work-task-title">要做什么 <span class="required-mark">*</span></label><input id="work-task-title" name="title" maxlength="120" placeholder="写下一个具体的小目标" required>
      <div class="form-columns"><div><label for="work-task-date">安排日期</label><input id="work-task-date" name="date" type="text" data-work-picker="date" required></div><div><label for="work-task-time">时间 <span class="optional-label">可选</span></label><input id="work-task-time" name="time" type="text" data-work-picker="time" placeholder="选择时间"><button type="button" class="clear-time" data-work-action="clear-time">清除时间</button></div></div>
      <div class="form-columns"><div><label for="work-task-category">分类</label>${categoryControl('work-task-category')}</div><label class="checkbox-field priority-field"><input type="checkbox" name="important"><span data-work-icon="flag"></span>这件事比较重要</label></div>
      <p class="input-help">分类可以选择已有值，也可以直接输入新名称；保存后即可复用。</p><label for="work-task-note">顺手记一点 <span class="optional-label">可选</span></label><textarea id="work-task-note" name="note" rows="3" maxlength="1000" placeholder="处理要点、需要的资料，或完成后的结果…"></textarea>
      <section class="task-knowledge-field" aria-labelledby="work-task-knowledge-label"><div class="field-heading"><span id="work-task-knowledge-label">关联知识 <span class="optional-label">可选</span></span><button class="text-button" type="button" data-work-action="new-linked-shortcut"><span data-work-icon="plus"></span>新建并关联</button></div><div id="work-task-linked" class="task-linked-chips"></div><label class="visually-hidden" for="work-task-knowledge-search">搜索可关联的知识入口</label><input id="work-task-knowledge-search" type="search" placeholder="搜索并选择已有入口…" autocomplete="off"><div id="work-task-knowledge-options" class="task-knowledge-options"></div><p class="input-help">资料继续在原工具中维护，保存待办后即可从事项中打开。</p></section>
      <p id="work-task-error" class="dialog-error" role="alert" hidden></p>
      <div class="dialog-actions"><button id="work-delete-task" type="button" class="delete-button" hidden>移除待办</button><div class="action-spacer"></div><button type="button" class="secondary" data-work-close>取消</button><button type="submit" class="primary">保存待办</button></div>
      <div class="meeting-task-entry"><span data-work-icon="clock"></span><span>需要到时间叫你？</span><button type="submit" name="intent" value="meeting" class="text-button">保存并建会议提醒 <span data-work-icon="arrow-right"></span></button></div>
    </form>
  </dialog>

  <dialog id="work-shortcut-dialog" class="editor-dialog" aria-labelledby="work-shortcut-dialog-title">
    <form id="work-shortcut-form">
      <div class="dialog-heading"><div><div class="eyebrow">常用的，就放在手边</div><h2 id="work-shortcut-dialog-title">添加知识入口</h2></div><button class="icon-button" type="button" data-work-close aria-label="关闭知识入口编辑"><span data-work-icon="x"></span></button></div>
      <input name="id" type="hidden">
      <label for="work-shortcut-title">入口名称 <span class="required-mark">*</span></label><input id="work-shortcut-title" name="title" maxlength="60" placeholder="例如：我的架构设计笔记" required>
      <label for="work-shortcut-kind">用什么打开</label><select id="work-shortcut-kind" name="kind"><option value="obsidian">Obsidian</option><option value="file">默认应用 / 资源管理器</option><option value="web">浏览器</option></select>
      <label for="work-shortcut-target" id="work-shortcut-target-label">笔记路径或 Obsidian 链接 <span class="required-mark">*</span></label><textarea id="work-shortcut-target" name="target" rows="2" maxlength="2000" required aria-describedby="work-shortcut-help"></textarea><div class="target-pickers"><button class="secondary" type="button" data-work-pick="file">选择文件</button><button class="secondary" type="button" data-work-pick="folder">选择文件夹</button></div><p id="work-shortcut-help" class="input-help">可以粘贴 Obsidian 中“复制 Obsidian URL”得到的链接，也可以填写本机笔记的完整路径。</p>
      <label for="work-shortcut-description">一句话说明 <span class="optional-label">可选</span></label><input id="work-shortcut-description" name="description" maxlength="100" placeholder="方便以后认出它">
      <label class="checkbox-field pin-field"><input name="pinned" type="checkbox" checked><span data-work-icon="pin"></span>放到每日待办旁边，随手打开</label>
      <p id="work-shortcut-error" class="dialog-error" role="alert" hidden></p>
      <div class="dialog-actions"><div class="action-spacer"></div><button type="button" class="secondary" data-work-close>取消</button><button type="submit" class="primary">保存入口</button></div>
    </form>
  </dialog>

  <dialog id="work-resource-dialog" class="editor-dialog resource-dialog" aria-labelledby="work-resource-dialog-title">
    <div class="dialog-heading"><div><div class="eyebrow">知识快捷入口</div><h2 id="work-resource-dialog-title"></h2></div><button class="icon-button" type="button" data-work-close aria-label="关闭入口详情"><span data-work-icon="x"></span></button></div>
    <p id="work-resource-description" class="resource-description"></p><label for="work-resource-target">原始位置</label><textarea id="work-resource-target" rows="3" readonly></textarea><p id="work-resource-note" class="input-help"></p>
    <div class="resource-options"><button id="work-edit-shortcut" class="secondary" type="button"><span data-work-icon="pencil"></span>编辑入口</button><button id="work-delete-shortcut" class="delete-button" type="button">移除入口</button></div>
    <div class="dialog-actions"><button id="work-copy-target" class="secondary" type="button"><span data-work-icon="copy"></span>复制地址</button><div class="action-spacer"></div><a id="work-resource-open" class="primary open-button" href="#">在 Obsidian 打开 <span data-work-icon="external"></span></a></div>
  </dialog>
  <div id="work-demo-toast" class="demo-toast" role="status" hidden><span data-work-icon="check"></span><span id="work-toast-text"></span><button id="work-toast-undo" type="button" hidden>撤销</button></div>
<footer class="demo-footer"><span><i></i>记录保存在这台电脑里</span><span>PetDesk · 每日待办 / 知识快捷入口</span></footer></div>`;
export const sidebarMarkup = `<div id="work-sidebar-progress-card" hidden>    <div class="sidebar-progress">
      <span class="sidebar-progress-label"><span data-work-icon="sprout"></span>今天的小进展</span>
      <strong id="work-sidebar-progress">完成了 2 件事</strong>
      <div class="progress-dots" id="work-progress-dots" aria-hidden="true"></div>
      <p>一步一步，事情就有了着落。</p>
    </div>
</div>`;
