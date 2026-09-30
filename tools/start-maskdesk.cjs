const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const root = path.join(__dirname, '..');
for (const [command, args] of [
  [process.execPath, [path.join(__dirname, 'prepare-tauri.cjs')]],
  ['cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']]
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const child = spawn(path.join(root, 'src-tauri/target/debug/petdesk.exe'), ['--maskdesk'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
