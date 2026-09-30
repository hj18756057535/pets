const $ = id => document.getElementById(id);
const invoke = window.__TAURI__?.core.invoke;
const call = async (channel, input = null) => {
  if (!invoke) throw new Error('请在 PetDesk 本地脱敏窗口中使用此功能。');
  try { return await invoke('maskdesk_call', { channel, input }); }
  catch (error) { throw new Error(String(error?.message || error)); }
};
let busy = false, sheet = null, previewId = null;
let mappingSummaries = [];
let ruleGroups = [], textPreviewId = null;
const detections = { text: null, sheet: null };
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
async function run(message, operation) {
  if (busy) return;
  busy = true; $('workspace').disabled = true; $('workspace').setAttribute('aria-busy', 'true'); status(message);
  try { await operation(); } catch (error) { status(error.message, true); }
  finally { busy = false; $('workspace').disabled = false; $('workspace').removeAttribute('aria-busy'); }
}
function invalidateSheet() {
  previewId = null; $('export-sheet').disabled = true;
  $('after-table').replaceChildren(); $('after-table').textContent = '规则尚未预览，请生成表格预览。';
  $('sheet-count').textContent = '选择要脱敏的列，然后生成预览。';
  $('sheet-mapping').textContent = '';
}
function invalidateText() {
  textPreviewId = null; $('export-text').disabled = true;
  $('result-text').value = ''; $('copy-text').disabled = true;
  $('text-count').textContent = '内容或规则已变更，请重新预览。';
  $('text-mapping').textContent = '';
}
function readKeywords() {
  return [...$('keyword-rules').children].map(row => ({ find: row.querySelector('.find').value, replace: $('reversible').checked ? '' : row.querySelector('.replace').value }));
}
function addKeyword(find = '', replace = '') {
  if ($('keyword-rules').children.length >= 100) { status('最多支持 100 条关键词规则。', true); return; }
  const row = document.createElement('div'); row.className = 'keyword-row';
  for (const [key, value, label] of [['find', find, '原关键词'], ['replace', replace, '替换值']]) {
    const input = document.createElement('input'); input.className = key; input.value = value;
    input.placeholder = label; input.setAttribute('aria-label', label); input.autocomplete = 'off'; input.spellcheck = false;
    if (key === 'replace') input.disabled = $('reversible').checked;
    row.append(input);
  }
  const remove = document.createElement('button'); remove.textContent = '移除'; remove.className = 'quiet';
  remove.addEventListener('click', () => { row.remove(); invalidateText(); invalidateSheet(); }); row.append(remove);
  row.addEventListener('input', () => { invalidateText(); invalidateSheet(); });
  $('keyword-rules').append(row);
}
function showTab(name) {
  for (const value of ['text', 'sheet', 'restore']) {
    $(value + '-page').hidden = value !== name;
    $(value + '-tab').classList.toggle('active', value === name);
    $(value + '-tab').setAttribute('aria-pressed', String(value === name));
  }
}
for (const name of ['text', 'sheet', 'restore']) $(name + '-tab').addEventListener('click', () => showTab(name));
$('reversible').addEventListener('change', () => {
  $('keyword-rules').querySelectorAll('.replace').forEach(input => { input.disabled = $('reversible').checked; });
  $('mode-note').textContent = $('reversible').checked ? '为关键词生成唯一占位符，忽略手填替换值。同一原值保持一致；文本和表格关键词规则均适用。星号掩码与固定值替换不可恢复。' : '普通模式使用手填替换值，不生成还原映射。需要把 AI 结果还原时，请开启可恢复模式后重新预览。';
  invalidateText(); invalidateSheet();
});
$('add-keyword').addEventListener('click', () => { addKeyword(); invalidateText(); invalidateSheet(); });
$('source-text').addEventListener('input', () => { invalidateText(); clearDetection('text'); });
$('load-example').addEventListener('click', () => {
  // An example should not silently discard a user's existing input.
  if ($('source-text').value || readKeywords().some(r => r.find || r.replace)) { status('请先清空本次会话，再填入演示数据。'); return; }
  $('keyword-rules').replaceChildren(); addKeyword('星河科技有限公司', '公司 A'); addKeyword('张小明', '联系人 A');
  $('source-text').value = '星河科技有限公司的张小明负责新项目，请帮我整理会议纪要。';
  invalidateText(); invalidateSheet(); status('演示数据已填入，可以生成文本预览。');
});
$('preview-text').addEventListener('click', () => run('正在本地替换…', async () => {
  invalidateText();
  const result = await call('text', { text: $('source-text').value, rules: readKeywords(), reversible: $('reversible').checked });
  $('result-text').value = result.text; $('copy-text').disabled = !result.text;
  textPreviewId = result.previewId; $('export-text').disabled = false;
  $('text-count').textContent = `匹配 ${result.matches} 处 · 输出 ${[...result.text].length} 个字符`;
  await recordMapping('text', result.mapping);
  status(result.matches ? '预览已生成，请检查后复制。' : '没有匹配到关键词，输出与原文相同，请检查规则。');
}));
$('copy-text').addEventListener('click', () => run('正在复制…', async () => {
  await navigator.clipboard.writeText($('result-text').value); status('脱敏结果已复制到系统剪贴板。');
}));
function letter(index) {
  let result = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
function table(target, rows, width, firstRow, before = null) {
  const el = document.createElement('table'), head = document.createElement('thead'), body = document.createElement('tbody');
  const title = document.createElement('tr');
  for (const label of ['行', ...Array.from({ length: width }, (_, i) => letter(i))]) {
    const th = document.createElement('th'); th.textContent = label; title.append(th);
  }
  head.append(title);
  rows.forEach((row, r) => {
    const tr = document.createElement('tr'), number = document.createElement('td'); number.textContent = firstRow + r + 1; tr.append(number);
    for (let c = 0; c < width; c++) {
      const td = document.createElement('td'); td.textContent = row[c] || '';
      if (before && (before[r]?.[c] || '') !== (row[c] || '')) td.className = 'changed'; tr.append(td);
    }
    body.append(tr);
  });
  el.append(head, body); target.replaceChildren(el);
  if (!rows.length) target.textContent = '工作表为空。';
}
function drawOptions(row) {
  const options = row.querySelector('.column-options'); options.replaceChildren();
  const mode = row.querySelector('select').value;
  if (mode === 'mask') {
    for (const [key, text, value] of [['head', '保留前', 1], ['tail', '后', 1]]) {
      const label = document.createElement('label'); label.textContent = text + ' ';
      const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1'; input.value = value; input.className = key;
      input.setAttribute('aria-label', `${text}几个字符`); label.append(input); options.append(label);
    }
    options.append('位');
  } else if (mode === 'replace') {
    const input = document.createElement('input'); input.type = 'text'; input.className = 'replacement'; input.placeholder = '固定替换值（留空则清空）'; input.setAttribute('aria-label', '列固定替换值'); input.autocomplete = 'off'; options.append(input);
  } else { options.textContent = '使用“文本替换”页中的关键词规则'; }
}
function loadSheet(data) {
  sheet = data; invalidateSheet(); clearDetection('sheet');
  $('file-info').textContent = `${data.rowCount} 行 · ${data.width} 列 · 数据起始于第 ${data.firstRow + 1} 行`;
  $('column-rules').replaceChildren();
  for (let column = 0; column < data.width; column++) {
    const row = document.createElement('div'); row.className = 'column-row'; row.dataset.column = column;
    const label = document.createElement('label'); label.className = 'column-name';
    const check = document.createElement('input'); check.type = 'checkbox';
    const name = document.createElement('span'); name.className = 'column-title'; label.append(check, name);
    const select = document.createElement('select'); select.setAttribute('aria-label', `${letter(column)} 列脱敏方式`);
    for (const [value, text] of [['mask', '保留首尾'], ['replace', '固定值替换'], ['keywords', '关键词替换']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    const options = document.createElement('div'); options.className = 'column-options'; row.append(label, select, options);
    select.addEventListener('change', () => { drawOptions(row); invalidateSheet(); });
    row.addEventListener('input', invalidateSheet); $('column-rules').append(row); drawOptions(row);
  }
  updateColumnNames(); table($('before-table'), data.rows, data.width, data.firstRow);
}
function updateColumnNames() {
  if (!sheet) return;
  [...$('column-rules').children].forEach((row, c) => {
    const title = $('has-header').checked ? sheet.rows[0]?.[c] : '';
    row.querySelector('.column-title').textContent = letter(c) + (title ? ` · ${title}` : ' 列');
  });
}
$('open-file').addEventListener('click', () => run('正在读取本地表格…', async () => {
  const result = await call('open');
  if (!result) { status('已取消选择文件。'); return; }
  $('file-name').textContent = result.name; $('sheet-select').replaceChildren();
  result.sheets.forEach((name, index) => { const option = document.createElement('option'); option.value = index; option.textContent = name; $('sheet-select').append(option); });
  $('file-empty').hidden = true; $('file-workspace').hidden = false; loadSheet(result.sheet);
  status('文件已读取，请勾选需要脱敏的列。');
}));
$('sheet-select').addEventListener('change', () => run('正在切换工作表…', async () => {
  sheet = null; invalidateSheet(); clearDetection('sheet'); $('column-rules').replaceChildren(); $('before-table').replaceChildren(); $('file-info').textContent = '正在读取…';
  loadSheet(await call('sheet', Number($('sheet-select').value))); status('工作表已切换，请重新设置列规则。');
}));
$('has-header').addEventListener('change', () => { updateColumnNames(); invalidateSheet(); clearDetection('sheet'); });
function columnRules() {
  return [...$('column-rules').children].filter(row => row.querySelector('input[type=checkbox]').checked).map(row => {
    const mode = row.querySelector('select').value;
    const rule = { mode };
    if (mode === 'mask') {
      for (const key of ['head', 'tail']) {
        const value = row.querySelector('.' + key).valueAsNumber;
        if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('首尾保留数量必须是 0～100 之间的整数。');
        rule[key] = value;
      }
    } else if (mode === 'replace') rule.value = row.querySelector('.replacement').value;
    else rule.rules = readKeywords();
    return { column: Number(row.dataset.column), rule };
  });
}
$('preview-sheet').addEventListener('click', () => run('正在处理整张工作表…', async () => {
  invalidateSheet();
  const result = await call('preview', { columns: columnRules(), header: $('has-header').checked, reversible: $('reversible').checked });
  table($('after-table'), result.after, result.width, result.firstRow, result.before);
  previewId = result.previewId; $('export-sheet').disabled = false;
  $('sheet-count').textContent = `共 ${result.rowCount} 行 · 修改 ${result.changedCells} 个单元格`;
  await recordMapping('sheet', result.mapping);
  status(result.changedCells ? '预览已生成，检查导出范围后可导出新文件。' : '没有单元格发生变化，请检查列选择、规则和数据。');
}));
$('export-sheet').addEventListener('click', () => run('正在生成 Excel 副本…', async () => {
  const result = await call('export', previewId);
  status(result ? `已导出：${result.name}。只包含当前工作表，原文件未修改。` : '已取消导出。');
}));
function clearSession() { return run('正在清空会话…', async () => {
  await call('clear'); sheet = null; invalidateSheet(); invalidateText();
  $('source-text').value = ''; $('keyword-rules').replaceChildren(); addKeyword();
  $('document-name').textContent = '也可直接粘贴文本。';
  $('column-rules').replaceChildren(); $('before-table').replaceChildren(); $('sheet-select').replaceChildren();
  $('file-name').textContent = ''; $('file-info').textContent = ''; $('file-empty').hidden = false; $('file-workspace').hidden = true;
  clearDetection('text'); clearDetection('sheet');
  mappingSummaries = []; renderMappings(); invalidateRestore(); $('ai-response').value = '';
  $('mapping-password').value = ''; $('mapping-password-confirm').value = '';
  $('has-header').checked = true; status('本次会话和映射已清空。已导出文件和系统剪贴板不受影响。');
}); }
$('clear-session').addEventListener('click', () => { if (mappingSummaries.length) $('clear-dialog').showModal(); else void clearSession(); });
$('cancel-clear').addEventListener('click', () => $('clear-dialog').close());
$('confirm-clear').addEventListener('click', () => { $('clear-dialog').close(); void clearSession(); });

function clearDetection(scope) {
  detections[scope] = null; $(scope + '-detection').hidden = true; $(scope + '-candidates').replaceChildren();
}
function renderDetection(scope, result) {
  detections[scope] = result.candidates;
  $(scope + '-detection').hidden = false;
  $(scope + '-detection-summary').textContent = `找到 ${result.candidates.length} 种候选。同一原值的所有出现位置会一起处理，请取消误报项。` + (result.truncated ? ' 仅显示前 100 种，尚有未列出的候选，请分批处理。' : '');
  const list = $(scope + '-candidates'); list.replaceChildren();
  for (const item of result.candidates) {
    const label = document.createElement('label'); label.className = 'candidate';
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = true;
    const info = document.createElement('span'), title = document.createElement('strong'), note = document.createElement('small');
    title.textContent = `${item.kind} · ${item.value} · ${item.count} 处` + (item.columns.length ? ` · ${item.columns.map(letter).join('、')} 列` : '');
    note.textContent = item.note; info.append(title, note); label.append(check, info); list.append(label);
  }
  $('apply-' + scope + '-candidates').disabled = !result.candidates.length;
}
for (const scope of ['text', 'sheet']) {
  $('detect-' + scope).addEventListener('click', () => run('正在本地识别敏感格式…', async () => {
    clearDetection(scope);
    const result = await call('detect-' + scope, scope === 'text' ? $('source-text').value : $('has-header').checked);
    renderDetection(scope, result); status(result.candidates.length ? '候选已列出，确认后再加入规则。' : '未发现所支持格式的候选；这不代表数据中没有敏感信息。');
  }));
  $('apply-' + scope + '-candidates').addEventListener('click', () => {
    const selected = (detections[scope] || []).filter((_, i) => $(scope + '-candidates').children[i].querySelector('input').checked);
    if (!selected.length) { status('请至少勾选一个候选。', true); return; }
    const existing = new Set(readKeywords().filter(r => r.find).map(r => r.find));
    const added = selected.filter(item => !existing.has(item.value));
    const blank = [...$('keyword-rules').children].filter(row => !row.querySelector('.find').value && !row.querySelector('.replace').value);
    if ($('keyword-rules').children.length - blank.length + added.length > 100) { status('合并后超过 100 条关键词，请减少勾选项或分批处理。', true); return; }
    blank.forEach(row => row.remove()); added.forEach(item => addKeyword(item.value, `[${item.kind}]`));
    if (scope === 'sheet') {
      const columns = new Set(selected.flatMap(item => item.columns));
      [...$('column-rules').children].forEach(row => { if (columns.has(Number(row.dataset.column))) {
        row.querySelector('input[type=checkbox]').checked = true; row.querySelector('select').value = 'keywords'; drawOptions(row);
      } });
    }
    invalidateText(); invalidateSheet(); status(`已加入 ${added.length} 条关键词${scope === 'sheet' ? '，候选所在列已改为关键词替换' : ''}，请生成预览。`);
  });
}

function invalidateRestore() {
  $('restored-text').value = ''; $('copy-restored').disabled = true;
  $('restore-count').textContent = '还原结果包含原始敏感信息，仅在本机显示。';
}
function renderMappings(selected = $('mapping-select').value) {
  $('mapping-select').replaceChildren();
  if (!mappingSummaries.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '尚无映射，请先生成可恢复预览或导入'; $('mapping-select').append(option);
  }
  for (const mapping of mappingSummaries) {
    const option = document.createElement('option'); option.value = mapping.id;
    option.textContent = `${mapping.kind} · ${new Date(mapping.createdAt).toLocaleString()} · ${mapping.count} 个原值 · ${mapping.id.slice(0, 8)}`;
    $('mapping-select').append(option);
  }
  if (mappingSummaries.some(m => m.id === selected)) $('mapping-select').value = selected;
  $('mapping-total').textContent = `${mappingSummaries.length} 份`;
  $('save-mapping').disabled = !$('mapping-select').value; $('restore-result').disabled = !$('mapping-select').value;
}
async function recordMapping(scope, summary) {
  if (!summary) { $(scope + '-mapping').textContent = '本次没有生成新映射；普通替换、星号掩码和固定值替换不可还原。'; return; }
  mappingSummaries = await call('mappings'); renderMappings(summary.id); invalidateRestore();
  $(scope + '-mapping').textContent = `已保留映射 ${summary.id.slice(0, 8)}（${summary.count} 个原值）。前往“AI 结果还原”使用或加密保存；请让 AI 保持占位符原样。`;
}
$('mapping-select').addEventListener('change', invalidateRestore);
$('ai-response').addEventListener('input', invalidateRestore);
$('restore-result').addEventListener('click', () => run('正在本地还原…', async () => {
  invalidateRestore();
  const result = await call('restore', { id: $('mapping-select').value, text: $('ai-response').value });
  $('restored-text').value = result.text; $('copy-restored').disabled = !result.text;
  $('restore-count').textContent = `还原 ${result.restored} 处 · 未识别占位符 ${result.unresolved} 处`;
  status(result.unresolved ? '部分占位符不属于所选映射或已被修改，已保留原样，请检查。' : result.restored ? '已生成还原预览，请检查后复制。' : '没有匹配到占位符，请核对映射与 AI 返回内容。');
}));
$('copy-restored').addEventListener('click', () => run('正在复制…', async () => { await navigator.clipboard.writeText($('restored-text').value); status('含原始信息的还原结果已复制。'); }));
$('copy-token-instruction').addEventListener('click', () => run('正在复制…', async () => {
  await navigator.clipboard.writeText('以下数据已在本地脱敏。请在分析、引用和输出表格中保持所有 [[PD_…]] 形式的占位符完整且原样，不改写、不拆分、不翻译、不推断真实值。相同占位符表示相同原值。');
  status('给 AI 的占位符说明已复制，请与脱敏结果一起发送。');
}));
for (const action of ['save', 'load']) $(action + '-mapping').addEventListener('click', () => run(action === 'save' ? '正在加密保存映射…' : '正在解密导入映射…', async () => {
  try {
    const password = $('mapping-password').value;
    if ([...password].length < 10) throw new Error('请输入至少 10 个字符的映射密码。');
    if (action === 'save' && password !== $('mapping-password-confirm').value) throw new Error('两次密码不一致，请重新输入。');
    const result = await call(action + '-mapping', action === 'save' ? { id: $('mapping-select').value, password } : password);
    if (!result) { status('已取消映射文件操作。'); return; }
    if (action === 'load') { mappingSummaries = await call('mappings'); renderMappings(result.id); invalidateRestore(); }
    status(action === 'save' ? `已加密保存：${result.name}。请单独保管映射和密码。` : '映射已解密导入，可以还原对应的 AI 结果。');
  } finally { $('mapping-password').value = ''; $('mapping-password-confirm').value = ''; }
}));
function rawKeywords() {
  return [...$('keyword-rules').children].map(row => ({ find: row.querySelector('.find').value, replace: row.querySelector('.replace').value }));
}
function renderRuleGroups(selected = $('rule-group-select').value) {
  $('rule-group-select').replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择已保存的规则组'; $('rule-group-select').append(placeholder);
  for (const group of ruleGroups) {
    const option = document.createElement('option'); option.value = group.name; option.textContent = `${group.name}（${group.rules.length} 条）`; $('rule-group-select').append(option);
  }
  $('rule-group-select').value = ruleGroups.some(g => g.name === selected) ? selected : '';
}
for (const action of ['load', 'merge']) $(action + '-rule-group').addEventListener('click', () => {
  const group = ruleGroups.find(g => g.name === $('rule-group-select').value);
  if (!group) { status('请先选择已保存的规则组。', true); return; }
  let rules = group.rules;
  if (action === 'merge') {
    const current = rawKeywords().filter(r => r.find || r.replace);
    const existing = new Map(current.map(r => [r.find, r.replace]));
    if (rules.some(r => existing.has(r.find) && existing.get(r.find) !== r.replace)) { status('存在同一关键词对应不同替换值，未合并。请先统一规则。', true); return; }
    rules = [...current, ...rules.filter(r => !existing.has(r.find))];
    if (rules.length > 100) { status('合并超过 100 条，未修改当前规则。', true); return; }
  }
  $('keyword-rules').replaceChildren(); rules.forEach(r => addKeyword(r.find, r.replace));
  $('rule-group-name').value = group.name; invalidateText(); invalidateSheet();
  status(`已${action === 'merge' ? '合并' : '加载'}规则组“${group.name}”，请重新预览。`);
});
for (const action of ['save', 'update']) $(action + '-rule-group').addEventListener('click', () => run('正在保存本地关键词库…', async () => {
  const name = action === 'update' ? $('rule-group-select').value : $('rule-group-name').value.trim();
  if (!name) throw new Error(action === 'update' ? '请先选择要更新的规则组。' : '请输入新规则组名称。');
  ruleGroups = await call('save-rule-group', { group: { name, rules: rawKeywords() }, overwrite: action === 'update' });
  renderRuleGroups(name); status(`规则组“${name}”已保存到本机，下次打开可继续使用。`);
}));
$('open-document').addEventListener('click', () => run('正在提取文档文字…', async () => {
  const result = await call('open-document');
  if (!result) { status('已取消导入。'); return; }
  $('source-text').value = result.text; $('document-name').textContent = result.name;
  $('text-export-format').value = result.name.toLowerCase().endsWith('.docx') ? 'docx' : 'txt';
  invalidateText(); clearDetection('text'); status('已导入文字，请检查提取内容，再使用关键词规则生成预览。');
}));
$('export-text').addEventListener('click', () => run('正在导出文字副本…', async () => {
  const result = await call('export-text', { id: textPreviewId, extension: $('text-export-format').value });
  status(result ? `已导出：${result.name}，原文件未修改。` : '已取消导出。');
}));
addKeyword();
if (invoke) call('rule-groups').then(groups => { ruleGroups = groups; renderRuleGroups(); }).catch(error => status(error.message, true));
