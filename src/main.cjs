const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, Notification, screen, powerMonitor, globalShortcut, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Store, makeReminder, dueIds, clampPosition, readPet, edgeSide, dockBounds, dockSize, expandedDockPosition } = require('./core.cjs');
const { readLocalPet, readSharedPet, commitPet } = require('./pet-import.cjs');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..');
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : root;
const smoke = process.argv.includes('--smoke-test');
const dataDir = path.join(portableRoot, '.data', ...(smoke ? [`smoke-${Date.now()}`] : []));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
app.setPath('userData', path.join(dataDir, 'runtime'));
app.setPath('sessionData', path.join(dataDir, 'runtime'));
app.setAppUserModelId('PetDesk.Local');
const store = new Store(dataDir);
const { EyeBreak } = require('./eye-break.cjs');
const eyeBreak = new EyeBreak();
let screenLocked = false;
let petWindow, panel, tray, pet, drag, tickTimer, dragTimer, heartbeatTimer;
let quitting = false;
let ignoreMouse = true;
let petHidden = false;
let runtimeWarning = '';
let panelTab = 'home';
let pendingImport = null, importController = null;
async function prepareImport(load) {
  if (importController) throw new Error('正在读取宠物，请稍等或先取消');
  const controller = new AbortController();
  importController = controller; pendingImport = null;
  try {
    const loaded = await load(controller.signal);
    if (!loaded || controller.signal.aborted) return null;
    pendingImport = { token: randomUUID(), pet: loaded };
    return { token: pendingImport.token, name: loaded.name, description: loaded.description, version: loaded.version, image: `data:image/webp;base64,${loaded.image.toString('base64')}` };
  } finally { if (importController === controller) importController = null; }
}
const size = () => ({ width: 320, height: Math.ceil(198 + 156 * store.state.settings.scale) });
const areas = () => screen.getAllDisplays().map(d => d.workArea);
function log(error) {
  try { fs.appendFileSync(path.join(dataDir, 'app.log'), `${new Date().toISOString()} ${error?.stack || error}\n`, 'utf8'); } catch {}
}
function payload() {
  const bounds = petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : null;
  const petEdge = bounds && !store.state.dock ? edgeSide(bounds, bounds, screen.getDisplayMatching(bounds).workArea, 25) : null;
  return { ...store.snapshot(), petEdge, eyeReminder: eyeBreak.pending, warning: runtimeWarning || store.warning, pet: pet ? { name: pet.name, description: pet.description, version: pet.version } : null, petVisible: !!petWindow?.isVisible(), version: app.getVersion() };
}
function broadcast() {
  for (const w of [petWindow, panel]) if (w && !w.isDestroyed()) w.webContents.send('state', payload());
  refreshTray();
}
function secureWindow(options, page) {
  const w = new BrowserWindow({ ...options, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', e => e.preventDefault());
  w.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  w.webContents.on('render-process-gone', (_e, details) => { log(JSON.stringify(details)); runtimeWarning = '窗口发生异常，请从托盘重新打开；已保存的提醒仍会继续检查。'; });
  w.loadFile(path.join(root, 'ui', page));
  return w;
}
function loadPet() {
  const candidates = [path.join(dataDir, 'pet'), path.join(root, '.local-pets', 'current')];
  for (const directory of candidates) {
    if (!fs.existsSync(path.join(directory, 'pet.json'))) continue;
    try { pet = readPet(directory); return; } catch (e) { log(e); runtimeWarning = `宠物包无法读取：${e.message}`; }
  }
}
function restorePosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  if (store.state.dock) {
    const display = screen.getAllDisplays().find(d => String(d.id) === store.state.dock.displayId) || screen.getPrimaryDisplay();
    petWindow.setBounds(dockBounds(store.state.dock, display.workArea));
    // Windows can impose a DPI-dependent minimum width. Align the actual
    // native window to the edge rather than leaving part beyond the screen.
    const actual = petWindow.getBounds();
    const area = display.workArea;
    petWindow.setPosition(store.state.dock.side === 'left' ? area.x : area.x + area.width - actual.width, Math.max(area.y, Math.min(actual.y, area.y + area.height - actual.height)));
    return;
  }
  const position = clampPosition(store.state.position, size(), areas());
  petWindow.setBounds({ ...position, ...size() });
}
function dockPet(side) {
  if (!petWindow || !pet) return;
  if (store.state.dock) return;
  const bounds = petWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  if (!['left', 'right'].includes(side)) side = bounds.x + bounds.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
  store.update(s => {
    s.position = { x: bounds.x, y: bounds.y };
    const center = bounds.y + 190 + 78 * s.settings.scale;
    s.dock = { side, displayId: String(display.id), y: Math.round(center - dockSize(area).height / 2), centerRatio: (center - area.y) / area.height };
  });
  restorePosition();
  broadcast();
}
function expandPet() {
  if (store.state.dock) {
    const dock = store.state.dock;
    const display = screen.getAllDisplays().find(d => String(d.id) === dock.displayId) || screen.getPrimaryDisplay();
    const bounds = petWindow?.getBounds();
    store.update(s => { s.position = expandedDockPosition({ ...dock, y: bounds?.y ?? dock.y }, display.workArea, size(), s.settings.scale, bounds?.height); s.dock = null; });
  }
  restorePosition();
  broadcast();
}
function createPetWindow() {
  petWindow = secureWindow({ ...size(), minWidth: 1, minHeight: 1, transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: false, show: false, backgroundColor: '#00000000' }, 'pet.html');
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  restorePosition();
  petWindow.once('ready-to-show', () => { if (pet && !petHidden) petWindow.showInactive(); });
  petWindow.on('closed', () => { petWindow = null; });
}
function showPet() {
  petHidden = false;
  if (!pet) { showPanel(); return; }
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  else { if (petWindow.webContents.isCrashed()) petWindow.reload(); petWindow.showInactive(); }
  expandPet();
  broadcast();
}
function showPanel(tab = 'home') {
  panelTab = tab;
  if (panel && !panel.isDestroyed()) { if (panel.webContents.isCrashed()) panel.reload(); panel.show(); panel.focus(); panel.webContents.send('tab', tab); return; }
  const area = screen.getPrimaryDisplay().workArea;
  panel = secureWindow({ width: Math.min(1060, area.width), height: Math.min(760, area.height), minWidth: Math.min(760, area.width), minHeight: Math.min(600, area.height), title: 'PetDesk · 你的桌面小伙伴', backgroundColor: '#f6f7f3', show: false, autoHideMenuBar: true, icon: path.join(root, 'assets', 'icon.png') }, 'index.html');
  panel.once('ready-to-show', () => panel.show());
  panel.on('close', e => { if (!quitting) { e.preventDefault(); panel.hide(); } });
  panel.on('closed', () => { panel = null; });
}
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开陪伴空间', click: () => showPanel() },
    { label: '添加会议提醒', click: () => showPanel('reminders') },
    { type: 'separator' },
    { label: petHidden ? '显示桌宠' : '暂时隐藏桌宠', click: () => { if (petHidden) showPet(); else { petHidden = true; petWindow?.hide(); broadcast(); } } },
    { label: store.state.dock ? '从侧边展开' : '收起到屏幕侧边', enabled: !!pet && !petHidden, click: () => { try { if (store.state.dock) expandPet(); else dockPet(); } catch (e) { log(e); } } },
    { label: '免打扰', type: 'checkbox', checked: store.state.settings.quiet, click: item => changeSettings({ quiet: item.checked }) },
    { label: '把宠物移回主屏幕', click: () => { store.update(s => { s.position = null; s.dock = null; }); restorePosition(); showPet(); } },
    { type: 'separator' },
    { label: '退出 PetDesk', click: () => app.quit() }
  ]));
}
function changeSettings(input) {
  const keys = ['quiet', 'sound', 'reducedMotion', 'eyeBreak'];
  for (const key of keys) if (key in input && typeof input[key] !== 'boolean') throw new Error('设置格式无效');
  if ('scale' in input && ![0.45, 0.6, 0.8, 1, 1.2].includes(input.scale)) throw new Error('不支持的宠物尺寸');
  if ('eyeMinutes' in input && (!Number.isInteger(input.eyeMinutes) || input.eyeMinutes < 5 || input.eyeMinutes > 180)) throw new Error('护眼提醒间隔为 5～180 分钟的整数');
  const resetEye = ('eyeBreak' in input && input.eyeBreak !== store.state.settings.eyeBreak) || ('eyeMinutes' in input && input.eyeMinutes !== store.state.settings.eyeMinutes);
  store.update(s => { for (const key of keys) if (key in input) s.settings[key] = input[key]; if ('scale' in input) s.settings.scale = input.scale; if ('eyeMinutes' in input) s.settings.eyeMinutes = input.eyeMinutes; });
  if (resetEye) eyeBreak.reset();
  restorePosition();
  broadcast();
  return payload();
}
function tick() {
  const eyeChanged = eyeBreak.tick({ enabled: store.state.settings.eyeBreak && !screenLocked, minutes: store.state.settings.eyeMinutes, quiet: store.state.settings.quiet, idleSeconds: powerMonitor.getSystemIdleTime() });
  if (eyeChanged) {
    broadcast();
    if (eyeBreak.pending && !store.state.reminders.some(r => r.status === 'active' || (r.status === 'pending' && Date.parse(r.dueAt) <= Date.now()))) notifyEyeBreak();
  }
  const due = dueIds(store.state.reminders);
  if (!due.length) return;
  try {
    store.update(s => { for (const r of s.reminders) if (due.includes(r.id)) r.status = 'active'; });
    runtimeWarning = '';
    broadcast();
    if (!store.state.settings.quiet) {
      if (!petHidden && pet && !store.state.dock) showPet();
      if (Notification.isSupported() && !smoke) {
        const first = store.state.reminders.find(r => r.id === due[0]);
        const notification = new Notification({ title: due.length > 1 ? `${due.length} 条会议提醒` : '小伙伴来提醒你啦', body: first.title, silent: !store.state.settings.sound, icon: path.join(root, 'assets', 'icon.png') });
        notification.on('click', () => showPanel('reminders'));
        notification.show();
      }
    }
  } catch (e) { log(e); runtimeWarning = '提醒保存失败，请检查磁盘空间与目录权限。系统会继续重试。'; broadcast(); }
}
function trusted(event) { return [petWindow, panel].some(w => w && !w.isDestroyed() && event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame); }
function notifyEyeBreak() {
  if (smoke || store.state.settings.quiet || !eyeBreak.pending || !Notification.isSupported()) return;
  const n = new Notification({ title: '小伙伴喊你歇一会儿', body: eyeBreak.pending.title, silent: !store.state.settings.sound, icon: path.join(root, 'assets', 'icon.png') });
  n.on('click', () => showPanel('settings')); n.show();
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, input) => {
    if (!trusted(event)) return { ok: false, error: '不允许的请求来源' };
    try { return { ok: true, value: await fn(input, event) }; }
    catch (e) { log(e); return { ok: false, error: e.message || '操作失败，请重试' }; }
  });
}
function endDrag() {
  if (!drag) return;
  const start = drag.position;
  clearInterval(dragTimer);
  dragTimer = null;
  drag = null;
  if (petWindow && !petWindow.isDestroyed()) {
    const [x, y] = petWindow.getPosition();
    try {
      store.update(s => { s.position = clampPosition({ x, y }, size(), areas()); });
      restorePosition();
      const moved = Math.hypot(x - start[0], y - start[1]) >= 4;
      const side = edgeSide(store.state.position, size(), screen.getDisplayMatching(petWindow.getBounds()).workArea);
      if (moved && side && !quitting) dockPet(side);
      else if (!quitting) broadcast();
    } catch (e) { log(e); }
  }
}
function installIPC() {
  handle('init', () => ({ ...payload(), tab: panelTab, image: pet ? `data:image/webp;base64,${pet.image.toString('base64')}` : null }));
  handle('settings', input => changeSettings(input || {}));
  handle('eye-break-action', input => { eyeBreak.action(input?.action); broadcast(); });
  handle('preview-eye-break', () => { if (!store.state.settings.eyeBreak) throw new Error('请先开启护眼提醒'); if (eyeBreak.show()) { broadcast(); if (!store.state.reminders.some(r => r.status === 'active')) notifyEyeBreak(); } });
  handle('add-reminder', input => { const reminder = makeReminder(input); store.update(s => { if (s.reminders.length >= 500) throw new Error('提醒数量已达上限，请先移除已完成记录'); s.reminders.push(reminder); }); broadcast(); tick(); return reminder; });
  handle('reminder-action', input => {
    if (!['done', 'snooze', 'remove'].includes(input?.action)) throw new Error('不支持的提醒操作');
    store.update(s => {
      const r = s.reminders.find(r => r.id === input.id);
      if (!r) throw new Error('找不到这条提醒');
      if (input.action === 'remove') s.reminders = s.reminders.filter(r => r.id !== input.id);
      else if (input.action === 'done') r.status = 'done';
      else { r.status = 'pending'; r.dueAt = new Date(Date.now() + 5 * 60000).toISOString(); }
    }); broadcast(); return payload();
  });
  handle('show-panel', tab => { showPanel(['home', 'reminders', 'settings'].includes(tab) ? tab : 'home'); });
  handle('show-pet', () => showPet());
  handle('dock-pet', () => dockPet());
  handle('expand-pet', () => expandPet());
  handle('hide-pet', () => { petHidden = true; petWindow?.hide(); broadcast(); });
  handle('play', action => { if (!['idle', 'waving', 'jumping', 'running', 'review'].includes(action)) throw new Error('未知动作'); petWindow?.webContents.send('play', action); });
  handle('import-pet', input => prepareImport(async () => {
    const kind = input?.kind || 'zip';
    if (!['zip', 'folder'].includes(kind)) throw new Error('请选择 ZIP 或文件夹');
    const choice = await dialog.showOpenDialog(panel, kind === 'folder'
      ? { title: '选择包含 pet.json 的宠物文件夹', properties: ['openDirectory'] }
      : { title: '选择下载的宠物 ZIP 压缩包', properties: ['openFile'], filters: [{ name: 'Codex 宠物压缩包', extensions: ['zip'] }] });
    if (choice.canceled) return null;
    return readLocalPet(choice.filePaths[0], kind);
  }));
  handle('preview-pet-link', input => prepareImport(signal => readSharedPet(input?.url, { signal })));
  handle('cancel-import', () => { importController?.abort(); pendingImport = null; });
  handle('apply-pet', input => {
    if (importController || !pendingImport || input?.token !== pendingImport.token) throw new Error('预览已失效，请重新读取宠物');
    const loaded = commitPet(dataDir, pendingImport.pet);
    pet = loaded; pendingImport = null;
    petWindow?.reload(); broadcast();
    return { name: pet.name };
  });
  handle('open-pet-website', () => shell.openExternal('https://codex-pets.net/'));
  handle('quit', () => app.quit());
  ipcMain.on('hit-test', (e, interactive) => {
    if (!trusted(e) || e.sender !== petWindow?.webContents || typeof interactive !== 'boolean' || drag) return;
    const next = !interactive;
    if (next !== ignoreMouse) { ignoreMouse = next; petWindow.setIgnoreMouseEvents(next, { forward: true }); }
  });
  ipcMain.on('drag-start', e => {
    if (!trusted(e) || e.sender !== petWindow?.webContents || drag || store.state.dock) return;
    drag = { cursor: screen.getCursorScreenPoint(), position: petWindow.getPosition(), time: Date.now() };
    petWindow.setIgnoreMouseEvents(false); ignoreMouse = false;
    dragTimer = setInterval(() => {
      if (Date.now() - drag.time > 30000) { endDrag(); return; }
      const c = screen.getCursorScreenPoint();
      const p = clampPosition({ x: drag.position[0] + c.x - drag.cursor.x, y: drag.position[1] + c.y - drag.cursor.y }, size(), areas());
      petWindow.setPosition(p.x, p.y);
    }, 16);
  });
  ipcMain.on('drag-end', e => { if (trusted(e)) endDrag(); });
}

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showPanel());
  app.whenReady().then(async () => {
    loadPet();
    try {
      const selection = JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-pet.json'), 'utf8'));
      if (typeof selection.directory === 'string' && /^pet-import-\d+(?:-[a-f0-9]{8})?$/.test(selection.directory)) pet = readPet(path.join(dataDir, selection.directory));
    } catch (e) { if (e.code !== 'ENOENT') { log(e); runtimeWarning = '上次导入的宠物无法读取，已尝试使用初始宠物。'; } }
    installIPC();
    createPetWindow();
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets', 'icon.png')));
    tray.setToolTip('PetDesk · 桌面小伙伴');
    tray.on('double-click', () => showPanel());
    refreshTray();
    globalShortcut.register('CommandOrControl+Shift+P', () => showPanel());
    screen.on('display-removed', () => { restorePosition(); broadcast(); });
    screen.on('display-metrics-changed', () => { restorePosition(); broadcast(); });
    powerMonitor.on('resume', () => { eyeBreak.reset(); broadcast(); tick(); });
    powerMonitor.on('suspend', () => { endDrag(); eyeBreak.reset(); broadcast(); });
    powerMonitor.on('lock-screen', () => { screenLocked = true; eyeBreak.reset(); broadcast(); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; eyeBreak.reset(); broadcast(); });
    tickTimer = setInterval(tick, 1000);
    // Hit-testing is also refreshed from the system cursor, including stationary cursors
    // when the animation changes underneath them.
    heartbeatTimer = setInterval(() => {
      if (!petWindow || !petWindow.isVisible() || drag) return;
      const c = screen.getCursorScreenPoint(); const b = petWindow.getBounds();
      petWindow.webContents.send('pointer', { x: c.x - b.x, y: c.y - b.y });
    }, 100);
    showPanel();
    tick();
    if (smoke) await require('../tools/smoke.cjs')({ app, panel, getPetWindow: () => petWindow, store, tick, root, dataDir });
  }).catch(e => { log(e); if (!smoke) dialog.showErrorBox('PetDesk 启动失败', e.message); app.exit(1); });
}
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; endDrag(); clearInterval(tickTimer); clearInterval(heartbeatTimer); globalShortcut.unregisterAll(); tray?.destroy(); });
