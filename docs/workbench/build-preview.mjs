// Build a double-clickable local preview; generated files stay in ignored artifacts/.
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const [source, baseStyle, demoStyle, sourceScript, logo, vendorStyle, pickerStyle, vendorScript, localeScript, pickerModule, workStyle, categoryStyle, viewModule, modelModule, categoryModule, workModule] = await Promise.all([
  read('demo.html'), read('../../ui/style.css'), read('demo.css'), read('demo.mjs'),
  readFile(new URL('../../assets/icon.png', import.meta.url)),
  read('../../node_modules/flatpickr/dist/flatpickr.min.css'), read('../../ui/date-time-picker.css'),
  read('../../node_modules/flatpickr/dist/flatpickr.min.js'), read('../../node_modules/flatpickr/dist/l10n/zh.js'),
  read('../../ui/date-time-picker.mjs'),
  read('../../ui/workbench.css'), read('../../ui/category-picker.css'),
  read('../../ui/workbench-view.mjs'), read('../../ui/workbench-model.mjs'),
  read('../../ui/category-picker.mjs'), read('../../ui/workbench.mjs'),
]);
const style = [vendorStyle, baseStyle, workStyle, pickerStyle, categoryStyle, demoStyle].join('\n');
const inline = source => source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const script = [viewModule, 'const esc = escapeHTML;', modelModule, pickerModule, categoryModule, workModule, sourceScript].map(inline).join('\n');
const scripts = [vendorScript, localeScript, script];
const hash = value => createHash('sha256').update(value, 'utf8').digest('base64');
if (scripts.some(value => /<\/script/i.test(value)) || /<\/style/i.test(style)) throw new Error('Unexpected closing tag in embedded asset');
const marker = '<!-- Generated standalone PetDesk demo from docs/workbench/ -->';
const target = new URL('../../artifacts/workbench-demo.html', import.meta.url);
let existing;
try { existing = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing && !existing.startsWith(marker)) throw new Error('Refusing to overwrite an unrelated preview');
const html = source
  .replace('<link rel="stylesheet" href="../../ui/style.css">', '')
  .replace('<link rel="stylesheet" href="../../node_modules/flatpickr/dist/flatpickr.min.css">', '')
  .replace('<link rel="stylesheet" href="../../ui/date-time-picker.css">', '')
  .replace('<link rel="stylesheet" href="../../ui/workbench.css">', '')
  .replace('<link rel="stylesheet" href="../../ui/category-picker.css">', '')
  .replace('<link rel="stylesheet" href="demo.css">', `<style>${style}</style>`)
  .replace('<script type="module" src="demo.mjs"></script>', `<script type="module">${script}</script>`)
  .replace('<script src="../../node_modules/flatpickr/dist/flatpickr.min.js"></script>', `<script>${vendorScript}</script>`)
  .replace('<script src="../../node_modules/flatpickr/dist/l10n/zh.js"></script>', `<script>${localeScript}</script>`)
  .replace("script-src 'self'", `script-src ${scripts.map(value => "'sha256-" + hash(value) + "'").join(' ')}`)
  .replace("style-src 'self'", `style-src 'sha256-${hash(style)}'`)
  .replaceAll('../../assets/icon.png', 'data:image/png;base64,' + logo.toString('base64'));
await mkdir(new URL('../../artifacts/', import.meta.url), {recursive: true});
await writeFile(target, marker + '\n' + html, 'utf8');
console.log('Standalone Demo: ' + fileURLToPath(target));
