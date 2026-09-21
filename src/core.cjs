const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function defaults() {
  return { version: 1, settings: { quiet: false, sound: false, reducedMotion: false, scale: 0.6, eyeBreak: true, eyeMinutes: 30 }, position: null, dock: null, reminders: [] };
}

function validateState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.reminders) || value.reminders.length > 500) throw new Error('不支持的本地数据格式');
  const result = defaults();
  for (const key of ['quiet', 'sound', 'reducedMotion']) result.settings[key] = value.settings?.[key] === true;
  const scale = value.settings?.scale;
  result.settings.eyeBreak = value.settings?.eyeBreak !== false;
  const minutes = value.settings?.eyeMinutes;
  result.settings.eyeMinutes = Number.isInteger(minutes) && minutes >= 5 && minutes <= 180 ? minutes : 30;
  result.settings.scale = [0.45, 0.6, 0.8, 1, 1.2].includes(scale) ? scale : 0.6;
  if (Number.isFinite(value.position?.x) && Number.isFinite(value.position?.y)) result.position = { x: Math.round(value.position.x), y: Math.round(value.position.y) };
  if (['left', 'right'].includes(value.dock?.side) && typeof value.dock.displayId === 'string' && Number.isFinite(value.dock.y)) result.dock = { side: value.dock.side, displayId: value.dock.displayId, y: Math.round(value.dock.y) };
  if (result.dock && Number.isFinite(value.dock.centerRatio)) result.dock.centerRatio = Math.max(0, Math.min(1, value.dock.centerRatio));
  const ids = new Set();
  result.reminders = value.reminders.map(r => {
    if (!r || typeof r.id !== 'string' || ids.has(r.id) || typeof r.title !== 'string' || !r.title.trim() || r.title.length > 100 || !Number.isFinite(Date.parse(r.dueAt)) || !Number.isFinite(Date.parse(r.meetingAt)) || !['pending', 'active', 'done'].includes(r.status)) throw new Error('提醒数据损坏');
    ids.add(r.id);
    return { id: r.id, title: r.title, dueAt: r.dueAt, meetingAt: r.meetingAt, status: r.status, createdAt: r.createdAt };
  });
  return result;
}

class Store {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'state.json');
    this.warning = '';
    fs.mkdirSync(directory, { recursive: true });
    this.state = defaults();
    if (fs.existsSync(this.file)) {
      try { this.state = validateState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch (error) {
        // Keep evidence before any new writes; never silently overwrite corrupt reminders.
        fs.copyFileSync(this.file, path.join(directory, `state.corrupt-${Date.now()}.json`));
        const backup = `${this.file}.bak`;
        try {
          this.state = validateState(JSON.parse(fs.readFileSync(backup, 'utf8')));
          this.warning = '本地数据异常，已从备份恢复。原文件已保留，请检查会议列表。';
        } catch { this.warning = '本地数据无法读取，原文件已保留。请重新检查并设置会议提醒。'; }
      }
    }
  }
  snapshot() { return structuredClone(this.state); }
  update(change) {
    const next = this.snapshot();
    change(next);
    const valid = validateState(next);
    const temp = `${this.file}.tmp`;
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(valid, null, 2), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) {
      try { validateState(JSON.parse(fs.readFileSync(this.file, 'utf8'))); fs.copyFileSync(this.file, `${this.file}.bak`); } catch (e) {
        if (e.code && e.code !== 'ENOENT') throw e;
      }
    }
    fs.renameSync(temp, this.file);
    this.state = valid;
    return this.snapshot();
  }
}

function makeReminder(input, now = Date.now()) {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const meeting = Date.parse(input?.meetingAt);
  const lead = Number(input?.leadMinutes ?? 0);
  if (!title || title.length > 100) throw new Error('请输入 1～100 字的会议名称');
  if (!Number.isFinite(meeting) || meeting <= now) throw new Error('请选择未来的会议时间');
  if (!Number.isInteger(lead) || lead < 0 || lead > 1440) throw new Error('提前提醒时间应为 0～1440 分钟');
  return { id: crypto.randomUUID(), title, meetingAt: new Date(meeting).toISOString(), dueAt: new Date(Math.max(now, meeting - lead * 60000)).toISOString(), status: 'pending', createdAt: new Date(now).toISOString() };
}

function dueIds(reminders, now = Date.now()) {
  return reminders.filter(r => r.status === 'pending' && Date.parse(r.dueAt) <= now).map(r => r.id);
}

function clampPosition(position, size, areas) {
  const candidates = areas.length ? areas : [{ x: 0, y: 0, width: 1280, height: 720 }];
  const desired = position || { x: candidates[0].x + candidates[0].width - size.width - 24, y: candidates[0].y + candidates[0].height - size.height - 12 };
  const area = candidates.find(a => desired.x + size.width / 2 >= a.x && desired.x + size.width / 2 < a.x + a.width && desired.y + size.height / 2 >= a.y && desired.y + size.height / 2 < a.y + a.height) || candidates.reduce((best, a) => {
    const distance = b => Math.hypot(desired.x - (b.x + b.width / 2), desired.y - (b.y + b.height / 2));
    return distance(a) < distance(best) ? a : best;
  });
  return { x: Math.round(Math.max(area.x, Math.min(desired.x, area.x + Math.max(0, area.width - size.width)))), y: Math.round(Math.max(area.y, Math.min(desired.y, area.y + Math.max(0, area.height - size.height)))) };
}

// Read dimensions without executing downloaded content or requiring image libraries.
function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('宠物图片必须是有效的 WebP');
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const p = offset + 8;
    if (p + length > buffer.length) break;
    if (type === 'VP8X' && length >= 10) return { width: buffer.readUIntLE(p + 4, 3) + 1, height: buffer.readUIntLE(p + 7, 3) + 1 };
    if (type === 'VP8 ' && length >= 10 && buffer[p + 3] === 0x9d && buffer[p + 4] === 0x01 && buffer[p + 5] === 0x2a) return { width: buffer.readUInt16LE(p + 6) & 0x3fff, height: buffer.readUInt16LE(p + 8) & 0x3fff };
    if (type === 'VP8L' && length >= 5 && buffer[p] === 0x2f) { const bits = buffer.readUInt32LE(p + 1); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    offset = p + length + (length % 2);
  }
  throw new Error('无法识别宠物图片尺寸');
}

function readPet(directory) {
  const manifest = path.join(directory, 'pet.json');
  if (fs.statSync(manifest).size > 64 * 1024) throw new Error('宠物配置文件过大');
  const meta = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
  const filename = meta.spritesheetPath || 'spritesheet.webp';
  if (typeof filename !== 'string' || filename !== path.basename(filename) || /[\\/:]/.test(filename)) throw new Error('宠物图片必须位于宠物目录内');
  const file = path.join(directory, filename);
  const realDir = fs.realpathSync(directory);
  const relative = path.relative(realDir, fs.realpathSync(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('宠物图片不能链接到其他目录');
  if (fs.statSync(file).size > 20 * 1024 * 1024) throw new Error('宠物图片不能超过 20 MB');
  const image = fs.readFileSync(file);
  const size = webpSize(image);
  const version = meta.spriteVersionNumber ?? 1;
  if (![1, 2].includes(version) || size.width !== 1536 || size.height !== (version === 2 ? 2288 : 1872)) throw new Error('目前支持标准 Codex V1 / V2 精灵图，请检查版本与尺寸');
  return { name: String(meta.displayName || meta.id || '我的宠物').slice(0, 60), description: String(meta.description || '').slice(0, 300), version, image, directory, size };
}

function edgeSide(position, size, area, threshold = 18) {
  if (position.x <= area.x + threshold) return 'left';
  if (position.x + size.width >= area.x + area.width - threshold) return 'right';
  return null;
}

function dockSize(area) {
  // Electron workArea is already in DPI-independent units; do not multiply by scaleFactor.
  const width = Math.round(Math.max(30, Math.min(42, Math.min(area.width, area.height) * .035)));
  return { width, height: Math.round(width * 1.7) };
}

function dockBounds(dock, area) {
  const { width, height } = dockSize(area);
  const y = Number.isFinite(dock.centerRatio) ? area.y + Math.max(0, Math.min(1, dock.centerRatio)) * area.height - height / 2 : dock.y;
  return { x: dock.side === 'left' ? area.x : area.x + area.width - width, y: Math.round(Math.max(area.y, Math.min(y, area.y + Math.max(0, area.height - height)))), width, height };
}

function expandedDockPosition(dock, area, size, scale, actualHeight = dockSize(area).height) {
  return clampPosition({ x: dock.side === 'left' ? area.x : area.x + area.width - size.width, y: dock.y + actualHeight / 2 - 190 - 78 * scale }, size, [area]);
}

module.exports = { defaults, validateState, Store, makeReminder, dueIds, clampPosition, webpSize, readPet, edgeSide, dockBounds, dockSize, expandedDockPosition };
