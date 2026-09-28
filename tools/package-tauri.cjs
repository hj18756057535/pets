const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('当前便携版打包需要 Windows');
const root = path.join(__dirname, '..');
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!fs.existsSync(cli)) throw new Error('请先运行 npm.cmd ci --cache .npm-cache');
const result = spawnSync(process.execPath, [cli, 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Tauri 构建失败，没有生成发布包');
const binary = path.join(root, 'src-tauri', 'target', 'release', 'petdesk.exe');
if (!fs.existsSync(binary)) throw new Error('Tauri 未生成 petdesk.exe');
const version = require('../package.json').version;
const name = `PetDesk-${version}-windows-${process.arch}-tauri-portable-${Date.now()}`;
const target = path.join(root, 'release', name);
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(binary, path.join(target, 'PetDesk.exe'));
fs.copyFileSync(path.join(root, 'tools', 'desktop-shortcut.vbs'), path.join(target, '创建桌面快捷方式.vbs'));
fs.writeFileSync(path.join(target, '使用说明.txt'), '\uFEFF' + [
  'PetDesk · Tauri Windows 便携版', '',
  '1. 将 ZIP 完整解压到当前用户可写的文件夹，双击 PetDesk.exe。',
  '2. Windows 需要 Microsoft Edge WebView2 Runtime；Windows 11 通常已预装。',
  '3. 首次打开后，通过界面导入 Codex 宠物 ZIP 或分享链接。',
  '4. 升级旧版时，先退出旧版，再将旧版 .data 文件夹复制到本 EXE 同目录。',
  '5. 设置和提醒保存在 EXE 同目录的 .data 文件夹，切勿随发布包分享。',
  '6. 退出请使用托盘菜单或设置中的“退出软件”。'
].join('\r\n'), 'utf8');
const archive = `${target}.zip`;
const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:PETDESK_PACKAGE_DIR, $env:PETDESK_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], { windowsHide: true, stdio: 'inherit', env: { ...process.env, PETDESK_PACKAGE_DIR: target, PETDESK_PACKAGE_ZIP: archive } });
if (zipped.error) throw zipped.error;
if (zipped.status !== 0) throw new Error('ZIP 生成失败，解压目录已保留');
const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`, 'utf8');
const nsis = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const installers = fs.readdirSync(nsis).filter(file => file.endsWith('.exe'))
  .map(file => path.join(nsis, file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!installers.length) throw new Error('Tauri 未生成 NSIS 安装包');
const installer = path.join(root, 'release', `PetDesk-${version}-windows-${process.arch}-tauri-setup-${Date.now()}.exe`);
fs.copyFileSync(installers[0], installer);
const installerHash = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
fs.writeFileSync(`${installer}.sha256`, `${installerHash}  ${path.basename(installer)}\n`, 'utf8');
console.log(`Tauri 安装包：${installer}\nSHA-256：${installerHash}\nTauri 便携版：${archive}\nSHA-256：${hash}`);
