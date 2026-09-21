const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
if (process.platform !== 'win32') throw new Error('当前便携版打包需要 Windows');
const version = require('../package.json').version;
const name = `PetDesk-${version}-windows-${process.arch}-portable-${Date.now()}`;
const target = path.join(root, 'release', name);
fs.cpSync(path.join(root, 'node_modules', 'electron', 'dist'), target, { recursive: true });
fs.renameSync(path.join(target, 'electron.exe'), path.join(target, 'PetDesk.exe'));
const application = path.join(target, 'resources', 'app'); fs.mkdirSync(application, { recursive: true });
for (const entry of ['src', 'ui', 'assets', 'package.json', 'README.md', 'LICENSE']) fs.cpSync(path.join(root, entry), path.join(application, entry), { recursive: true });
const copied = new Set();
function copyDependency(name, from = root) {
  const manifest = require.resolve(`${name}/package.json`, { paths: [from] });
  if (copied.has(manifest)) return;
  copied.add(manifest);
  const source = path.dirname(manifest);
  fs.cpSync(source, path.join(application, 'node_modules', name), { recursive: true });
  for (const dependency of Object.keys(require(manifest).dependencies || {})) copyDependency(dependency, source);
}
for (const name of Object.keys(require('../package.json').dependencies || {})) copyDependency(name);
fs.copyFileSync(path.join(root, 'tools', 'desktop-shortcut.vbs'), path.join(target, '创建桌面快捷方式.vbs'));
fs.writeFileSync(path.join(target, '使用说明.txt'), '\uFEFF' + [
  'PetDesk · Windows 便携版', '',
  '1. 先将整个 ZIP 解压到自己的文件夹。',
  '2. 双击 PetDesk.exe 即可启动，无需安装 Node.js 或 npm。',
  '3. 首次启动点击“导入宠物”，从 https://codex-pets.net/ 下载宠物 ZIP 或复制分享链接。',
  '4. 可运行“创建桌面快捷方式.vbs”；也可右键 PetDesk.exe 创建桌面快捷方式。',
  '5. 双击宠物打开陪伴空间，拖到屏幕左右边缘后松手即可收起。',
  '', '请保留完整目录，不要只移动 EXE。移动目录后重新创建快捷方式。',
  '个人数据保存在同目录的 .data 文件夹，请勿分享该文件夹。',
  '关闭陪伴空间后仍会运行；彻底退出请使用系统托盘菜单。',
  '升级请先退出旧版，将旧版 .data 备份并复制到新版目录。',
  '当前为未签名预览版，不含第三方宠物素材。'
].join('\r\n'), 'utf8');
const archive = `${target}.zip`;
const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:PETDESK_PACKAGE_DIR, $env:PETDESK_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], { windowsHide: true, stdio: 'inherit', env: { ...process.env, PETDESK_PACKAGE_DIR: target, PETDESK_PACKAGE_ZIP: archive } });
if (zipped.error) throw zipped.error;
if (zipped.status !== 0) throw new Error('ZIP 生成失败，解压目录已保留');
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`, 'utf8');
console.log(`便携版已生成：${archive}\nSHA-256：${hash}\n无需 npm；不包含私人宠物包和个人数据。首次打开后通过界面导入宠物。`);
