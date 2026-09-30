const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const yauzl = require('yauzl');
const root = path.join(__dirname, '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Smoke build failed');
};
function verifyExport(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const xml = new Map();
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (!entry.fileName.endsWith('.xml')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
          stream.on('end', () => { xml.set(entry.fileName, Buffer.concat(chunks).toString('utf8')); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        const values = xml.get('xl/sharedStrings.xml') || '';
        const sheets = [...xml.keys()].filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
        if (sheets.length !== 1 || !values.includes('张****明') || !values.includes('138****5678') || /张小明|13812345678|不应导出/.test([...xml.values()].join('')) || sheets.some(name => /<f[ >]/.test(xml.get(name)))) {
          reject(new Error('Export content did not match the reviewed masked snapshot')); return;
        }
        resolve();
      });
      zip.readEntry();
    });
  });
}
async function main() {
  run(process.execPath, [path.join(__dirname, 'prepare-tauri.cjs')]);
  const data = path.join(root, 'artifacts', `maskdesk-smoke-${Date.now()}`);
  fs.mkdirSync(data, { recursive: true });
  // Separate binary: the user's running pet may lock target/debug/petdesk.exe.
  const executable = path.join(data, 'petdesk-smoke.exe');
  run('cargo', ['rustc', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--bin', 'petdesk', '--', '-o', executable]);
  const child = spawn(executable, ['--maskdesk'], {
    cwd: root, windowsHide: true, env: { ...process.env, PETDESK_MASK_SMOKE: '1', PETDESK_DATA_DIR: data }
  });
  let output = '', spawnError;
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  child.on('error', error => { spawnError = error; });
  try {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`MaskDesk exited: ${child.exitCode}\n${output}`);
      const report = path.join(data, 'smoke-maskdesk.json');
      if (fs.existsSync(report)) {
        const result = JSON.parse(fs.readFileSync(report, 'utf8'));
        if (!result.ok) throw new Error(JSON.stringify(result));
        const exported = fs.readdirSync(data).find(name => /^测试客户_客户_脱敏_.*\.xlsx$/.test(name));
        if (!exported) throw new Error('Missing source-named export');
        await verifyExport(path.join(data, exported));
        result.checks.push('导出仅含脱敏工作表，无原值或公式');
        await verifyDocuments(data);
        result.checks.push('实际 Word/TXT 输出含占位符，无已替换原值和原文档附件');
        if (fs.existsSync(path.join(data, 'state.json')) || fs.existsSync(path.join(data, 'app.log'))) throw new Error('MaskDesk started pet persistence');
        console.log(JSON.stringify({ ...result, report: data }, null, 2)); return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('MaskDesk smoke timed out: ' + data + '\n' + output);
  } finally {
    fs.writeFileSync(path.join(data, 'process.log'), output, 'utf8');
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

async function verifyDocuments(data) {
  const files = fs.readdirSync(data);
  const txtName = files.find(n => /^测试合同_脱敏_.*\.txt$/.test(n));
  const docxName = files.find(n => /^测试合同_脱敏_.*\.docx$/.test(n));
  if (!txtName || !docxName) throw new Error('Missing document exports');
  const txt = fs.readFileSync(path.join(data, txtName), 'utf8');
  if (!txt.includes('[[PD_') || txt.includes('星河科技有限公司')) throw new Error('TXT output leaked replaced keyword');
  await new Promise((resolve, reject) => {
    yauzl.open(path.join(data, docxName), { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const names = [], chunks = [];
      zip.on('error', reject);
      zip.on('entry', entry => {
        names.push(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
          stream.on('end', () => zip.readEntry());
        });
      });
      zip.on('end', () => {
        const xml = Buffer.concat(chunks).toString('utf8');
        if (names.length !== 3 || !names.includes('word/document.xml') || !xml.includes('[[PD_') || xml.includes('星河科技有限公司')) return reject(new Error('Word export content mismatch'));
        resolve();
      });
      zip.readEntry();
    });
  });
}
