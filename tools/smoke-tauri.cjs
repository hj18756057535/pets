const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed: ${command}`);
};
async function main() {
  run(process.execPath, [path.join(__dirname, 'prepare-tauri.cjs')]);
  run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked']);
  const data = path.join(root, 'artifacts', `tauri-smoke-${Date.now()}`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ version: 1, settings: { quiet: true }, position: null, dock: { side: "left", displayId: "primary", y: 200, centerRatio: 0.5 }, reminders: [] }));
  const launcher = process.argv.includes('--launcher');
  const executable = launcher ? 'cmd.exe' : path.join(root, 'src-tauri', 'target', 'debug', 'petdesk.exe');
  const args = launcher ? ['/d', '/c', path.join(root, '启动桌宠.cmd')] : [];
  const launchedAt = Date.now();
  let startupMs;
  const child = spawn(executable, args, {
    cwd: root, windowsHide: true,
    env: { ...process.env, PETDESK_SMOKE: '1', PETDESK_DATA_DIR: data }
  });
  let output = '', spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', text => { output += text; });
  child.stderr.on('data', text => { output += text; });
  const read = label => {
    try { return JSON.parse(fs.readFileSync(path.join(data, `smoke-${label}.json`), 'utf8')); }
    catch { return null; }
  };
  try {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (startupMs === undefined) {
        try {
          const log = fs.readFileSync(path.join(data, 'app.log'), 'utf8');
          if (log.includes('frontend ready: panel') && log.includes('frontend ready: pet')) startupMs = Date.now() - launchedAt;
        } catch {}
      }
      if (child.exitCode !== null && (!launcher || child.exitCode !== 0)) throw new Error(`App exited: ${child.exitCode}\n${output}`);
      const panel = read('panel'), pet = read('pet');
      if (panel?.ok === false || pet?.ok === false) throw new Error(JSON.stringify({ panel, pet }));
      if (panel?.ok && pet?.ok && pet.pet === 'Smoke second') {
        if (launcher) {
          const pid = Number(fs.readFileSync(path.join(data, 'launcher.pid'), 'ascii').trim());
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
          if (alive) throw new Error('PowerShell launcher is still running');
          if (!fs.readFileSync(path.join(data, 'launcher.log'), 'utf8').includes('Using cached executable')) throw new Error('Launcher rebuilt unchanged sources');
        }
        console.log(JSON.stringify({ ok: true, startupMs, panel: panel.checks, pet: pet.pet, report: data }, null, 2));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Tauri pages did not finish the smoke test. Reports: ${data}\n${output}`);
  } finally {
    fs.writeFileSync(path.join(data, 'process.log'), output);
    if (launcher) {
      try {
        const pid = Number(fs.readFileSync(path.join(data, 'app.pid'), 'ascii').trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid);
      } catch {}
    }
    if (child.exitCode === null) {
      if (launcher) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
