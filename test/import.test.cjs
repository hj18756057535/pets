const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { parseShareLink, readZip, readSharedPet, fetchLimited, commitPet } = require('../src/pet-import.cjs');

// Small synthetic ZIPs exercise malformed input without distributing pet artwork.
function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data || ''), method = entry.method ?? 0;
    const packed = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = entry.crc ?? zlib.crc32(data), length = entry.length ?? data.length;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(0x314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(entry.attributes ?? 0, 38); ch.writeUInt32LE(offset, 42);
    local.push(lh, name, packed); central.push(ch, name); offset += lh.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
function image() { const b = Buffer.alloc(30); b.write('RIFF'); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUInt32LE(10, 16); b.writeUIntLE(1535, 24, 3); b.writeUIntLE(1871, 27, 3); return b; }
function files(prefix = '', method = 0) { return [{ name: `${prefix}pet.json`, data: JSON.stringify({ displayName: '测试伙伴', spritesheetPath: 'spritesheet.webp' }), method }, { name: `${prefix}spritesheet.webp`, data: image(), method }]; }
test('支持分享页、详情页和带 hash 的旧链接，移除追踪参数', () => {
  for (const u of ['https://codex-pets.net/share/tiebaojin-dog?utm_source=abc', 'https://codex-pets.net/#/pets/tiebaojin-dog', 'https://codex-pets.net/pets/tiebaojin-dog/']) assert.equal(parseShareLink(u).id, 'tiebaojin-dog');
  for (const u of ['http://codex-pets.net/share/dog', 'https://codex-pets.net.evil.test/share/dog', 'https://user@codex-pets.net/share/dog', 'https://codex-pets.net/', 'file:///test', 'https://codex-pets.net/share/../x']) assert.throws(() => parseShareLink(u));
});
test('支持根目录和嵌套文件夹 ZIP 的 stored/deflate 两种压缩方式', async () => {
  for (const prefix of ['', 'doge/', '下载/宠物/']) for (const method of [0, 8]) { const pet = await readZip(zip(files(prefix, method))); assert.equal(pet.name, '测试伙伴'); assert.equal(pet.version, 1); }
});
test('拒绝路径穿越、符号链接、重复文件、多宠物和缺图包', async () => {
  for (const entries of [[...files(), { name: '../outside.txt' }], [...files(), { name: '/absolute.txt' }], [...files(), { name: 'link', attributes: 0xa0000000 }], [...files(), files()[0]], [...files(), ...files('other/')], [files()[0]]]) await assert.rejects(readZip(zip(entries)));
});
test('拒绝损坏 CRC、截断 ZIP 及解压体积超限', async () => {
  await assert.rejects(readZip(zip([{ ...files()[0], crc: 123 }, files()[1]])), /校验/);
  await assert.rejects(readZip(zip(files()).subarray(0, 35)));
  await assert.rejects(readZip(zip([{ ...files()[0], method: 8, length: 30 * 1024 * 1024 }, files()[1]])), /25 MB/);
});
test('网络请求拒绝跨站跳转和流式超限，不发送用户凭据', async () => {
  await assert.rejects(fetchLimited('https://codex-pets.net/test', 100, undefined, async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })), /不属于/);
  await assert.rejects(fetchLimited('https://codex-pets.net/test', 3, undefined, async (_url, options) => { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); return new Response('oversize'); }), /大小限制/);
});
test('详情接口获取 ZIP 后完整解析；404 和无下载地址返回可理解的错误', async () => {
  const fetcher = async url => url.includes('/download') ? new Response(zip(files())) : new Response(JSON.stringify({ pet: { downloadUrl: '/api/pets/dog/download' } }));
  assert.equal((await readSharedPet('https://codex-pets.net/share/dog', { fetcher })).name, '测试伙伴');
  await assert.rejects(readSharedPet('https://codex-pets.net/share/dog', { fetcher: async () => new Response('', { status: 404 }) }), /没有找到/);
  await assert.rejects(readSharedPet('https://codex-pets.net/share/dog', { fetcher: async () => new Response('{}') }), /没有提供/);
});
test('取消网络导入会中止请求', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSharedPet('https://codex-pets.net/share/dog', { signal: controller.signal, fetcher: async (_url, options) => { options.signal.throwIfAborted(); } }), /取消/);
});
test('仅完整有效宠物能提交，失败时不改变原选择及原资源', async () => {
  const root = path.join(__dirname, '..', '.data', 'tests'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'import-'));
  const pet = await readZip(zip(files())); const first = commitPet(directory, pet);
  const selection = fs.readFileSync(path.join(directory, 'selected-pet.json'), 'utf8');
  assert.throws(() => commitPet(directory, { ...pet, version: 2 }));
  assert.equal(fs.readFileSync(path.join(directory, 'selected-pet.json'), 'utf8'), selection);
  assert.deepEqual(fs.readFileSync(path.join(first.directory, 'spritesheet.webp')), pet.image);
});
