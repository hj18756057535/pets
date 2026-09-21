const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const yauzl = require('yauzl');
const { readPet, webpSize } = require('./core.cjs');
const MAX_ZIP = 25 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const SITE = 'https://codex-pets.net';

function parseShareLink(value) {
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch { throw new Error('请粘贴完整的 Codex Pets 分享链接'); }
  if (url.origin !== SITE || url.username || url.password) throw new Error('目前只支持 https://codex-pets.net 的宠物链接');
  const route = url.pathname === '/' && url.hash.startsWith('#/') ? url.hash.slice(1).split('?')[0] : url.pathname;
  const match = /^\/(?:share|pets)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,150})\/?$/.exec(route);
  if (!match) throw new Error('链接应指向一只宠物，例如 /share/tiebaojin-dog');
  return { id: match[1], url: `${SITE}/share/${match[1]}` };
}

function packageFromFiles(files) {
  const manifests = [...files.keys()].filter(name => path.posix.basename(name) === 'pet.json' && !name.startsWith('__MACOSX/'));
  if (manifests.length !== 1) throw new Error('压缩包中需要恰好一份 pet.json，请一次导入一只宠物');
  let meta;
  try { meta = JSON.parse(files.get(manifests[0]).toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('pet.json 不是有效的 JSON 文件'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('pet.json 格式不正确');
  const filename = meta.spritesheetPath || 'spritesheet.webp';
  if (typeof filename !== 'string' || /[\\/:\x00]/.test(filename) || filename === '.' || filename === '..') throw new Error('宠物图片必须与 pet.json 在同一个文件夹');
  const imagePath = path.posix.join(path.posix.dirname(manifests[0]), filename);
  const image = files.get(imagePath);
  if (!image) throw new Error('压缩包中缺少 pet.json 指定的精灵图');
  if (image.length > MAX_IMAGE) throw new Error('宠物图片不能超过 20 MB');
  const size = webpSize(image), version = meta.spriteVersionNumber ?? 1;
  if (![1, 2].includes(version) || size.width !== 1536 || size.height !== (version === 2 ? 2288 : 1872)) throw new Error('宠物版本与精灵图尺寸不匹配，目前支持标准 Codex V1 / V2');
  return { name: String(meta.displayName || meta.id || '我的宠物').slice(0, 60), description: String(meta.description || '').slice(0, 300), version, image, size };
}

async function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_ZIP) throw new Error('ZIP 压缩包不能超过 25 MB');
  let zip;
  try { zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }); }
  catch { throw new Error('无法读取 ZIP，请确认下载完整且不是加密压缩包'); }
  const files = new Map(), names = new Set();
  let total = 0, entries = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (++entries > 128) throw new Error('压缩包文件过多，请选择单只宠物的资源包');
      const name = entry.fileName;
      if (/[\\:\x00]/.test(name) || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.')) throw new Error('压缩包包含不安全的文件路径');
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error('压缩包包含重复文件');
      names.add(key);
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('宠物包不能包含符号链接');
      if (entry.generalPurposeBitFlag & 1) throw new Error('暂不支持加密 ZIP');
      total += entry.uncompressedSize;
      if (total > MAX_ZIP) throw new Error('压缩包解压后超过 25 MB');
      if (name.endsWith('/')) continue;
      // Never extract arbitrary paths. Read only metadata and images into memory.
      const manifest = path.posix.basename(name) === 'pet.json';
      if (!manifest && !name.toLowerCase().endsWith('.webp')) continue;
      const limit = manifest ? 64 * 1024 : MAX_IMAGE;
      if (entry.uncompressedSize > limit) throw new Error(manifest ? 'pet.json 文件过大' : '宠物图片不能超过 20 MB');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = []; let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > limit) { stream.destroy(); throw new Error('解压后的文件超出大小限制'); }
        chunks.push(chunk);
      }
      const contents = Buffer.concat(chunks);
      if (zlib.crc32(contents) !== entry.crc32) throw new Error('压缩包校验失败，请重新下载');
      files.set(name, contents);
    }
    return packageFromFiles(files);
  } finally { zip.close(); }
}

async function readLocalPet(filename, kind) {
  if (kind === 'folder') return readPet(filename);
  const stat = await fs.promises.stat(filename);
  if (!stat.isFile() || stat.size > MAX_ZIP) throw new Error('请选择不超过 25 MB 的 ZIP 压缩包');
  return readZip(await fs.promises.readFile(filename));
}

function checkedURL(input, base = SITE) {
  let url;
  try { url = new URL(input, base); } catch { throw new Error('网站返回了无效的下载地址'); }
  if (url.origin !== SITE || url.username || url.password) throw new Error('下载地址不属于 Codex Pets，已停止导入');
  return url;
}

async function fetchLimited(input, limit, signal, fetcher = fetch) {
  let url = checkedURL(input);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetcher(url.href, { signal, redirect: 'manual', credentials: 'omit', headers: { Accept: 'application/json, application/zip, application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('网站返回了无效的跳转');
      url = checkedURL(location, url.href); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 404 ? '没有找到这只宠物，可能已被删除或链接不正确' : `网站暂时无法下载（HTTP ${response.status}），请稍后重试`); }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('下载文件超过大小限制'); }
    if (!response.body) throw new Error('网站返回了空文件');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) { await reader.cancel(); throw new Error('下载文件超过大小限制'); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  throw new Error('下载跳转次数过多，请改用 ZIP 导入');
}

async function readSharedPet(input, { signal, fetcher = fetch } = {}) {
  const link = parseShareLink(input);
  const timeout = AbortSignal.timeout(45000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const raw = await fetchLimited(`${SITE}/api/pets/${encodeURIComponent(link.id)}`, 256 * 1024, requestSignal, fetcher);
    let metadata;
    try { metadata = JSON.parse(raw.toString('utf8')); } catch { throw new Error('网站接口暂时不可用，请改用下载后的 ZIP 导入'); }
    if (typeof metadata?.pet?.downloadUrl !== 'string') throw new Error('网站没有提供宠物下载地址，请改用 ZIP 导入');
    const bytes = await fetchLimited(metadata.pet.downloadUrl, MAX_ZIP, requestSignal, fetcher);
    const pet = await readZip(bytes);
    return { ...pet, source: link.url };
  } catch (error) {
    if (signal?.aborted) throw new Error('已取消导入');
    if (timeout.aborted || error.name === 'TimeoutError') throw new Error('下载超时，请重试或使用本地 ZIP 导入');
    if (error instanceof TypeError) throw new Error('暂时无法连接 Codex Pets，请检查网络或使用本地 ZIP 导入');
    throw error;
  }
}

function commitPet(dataDir, pet) {
  const directory = `pet-import-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = path.join(dataDir, directory);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'spritesheet.webp'), pet.image);
  fs.writeFileSync(path.join(destination, 'pet.json'), JSON.stringify({ displayName: pet.name, description: pet.description, spritesheetPath: 'spritesheet.webp', spriteVersionNumber: pet.version }, null, 2), 'utf8');
  const loaded = readPet(destination);
  const selection = path.join(dataDir, 'selected-pet.json');
  const temp = `${selection}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ directory, source: pet.source || 'local' }), 'utf8');
  fs.renameSync(temp, selection);
  return loaded;
}

module.exports = { parseShareLink, readZip, readLocalPet, readSharedPet, commitPet, fetchLimited, MAX_ZIP };
