const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const target = path.join(root, 'dist-tauri');
if (path.relative(root, target) !== 'dist-tauri' || (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())) {
  throw new Error('Refusing to replace an unexpected Tauri output path');
}
function writeChanged(file, bytes) {
  if (fs.existsSync(file)) {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Unexpected link: ${file}`);
    if (fs.readFileSync(file).equals(bytes)) return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
const expected = new Set();
function copyTree(source, destination) {
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error(`Unexpected link: ${destination}`);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source link: ${entry.name}`);
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) { copyTree(from, to); continue; }
    let bytes = fs.readFileSync(from);
    if (['index.html', 'pet.html'].includes(entry.name)) {
      bytes = Buffer.from(bytes.toString('utf8').replaceAll('../assets/', 'assets/')
        .replace('</body>', '  <script src="tauri-bridge.js"></script>\n</body>'));
    }
    expected.add(to); writeChanged(to, bytes);
  }
}
copyTree(path.join(root, 'ui'), target);
copyTree(path.join(root, 'assets'), path.join(target, 'assets'));
function removeStaleFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected output link: ${file}`);
    if (entry.isDirectory()) removeStaleFiles(file);
    else if (!expected.has(file)) fs.unlinkSync(file);
  }
}
removeStaleFiles(target);
// ICO accepts a PNG payload on modern Windows; no image tool is required.
const png = fs.readFileSync(path.join(root, 'assets', 'icon.png'));
const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || width > 256 || height > 256) throw new Error('assets/icon.png must be a PNG no larger than 256×256');
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = width === 256 ? 0 : width; ico[7] = height === 256 ? 0 : height;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
const icons = path.join(root, 'src-tauri', 'icons');
fs.mkdirSync(icons, { recursive: true });
writeChanged(path.join(icons, 'icon.ico'), ico);
console.log('Tauri frontend ready:', target);
