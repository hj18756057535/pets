// Explicit allowlist: the preview never exposes a vault, .data, or arbitrary files.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const files = new Map([
  ['/docs/workbench/demo.html', ['demo.html', 'text/html']],
  ['/docs/workbench/demo.css', ['demo.css', 'text/css']],
  ['/docs/workbench/demo.mjs', ['demo.mjs', 'text/javascript']],
  ['/ui/style.css', ['../../ui/style.css', 'text/css']],
  ['/ui/date-time-picker.css', ['../../ui/date-time-picker.css', 'text/css']],
  ['/ui/date-time-picker.mjs', ['../../ui/date-time-picker.mjs', 'text/javascript']],
  ['/ui/workbench.css', ['../../ui/workbench.css', 'text/css']],
  ['/ui/workbench.mjs', ['../../ui/workbench.mjs', 'text/javascript']],
  ['/ui/workbench-view.mjs', ['../../ui/workbench-view.mjs', 'text/javascript']],
  ['/ui/workbench-model.mjs', ['../../ui/workbench-model.mjs', 'text/javascript']],
  ['/ui/category-picker.css', ['../../ui/category-picker.css', 'text/css']],
  ['/ui/category-picker.mjs', ['../../ui/category-picker.mjs', 'text/javascript']],
  ['/node_modules/flatpickr/dist/flatpickr.min.css', ['../../node_modules/flatpickr/dist/flatpickr.min.css', 'text/css']],
  ['/node_modules/flatpickr/dist/flatpickr.min.js', ['../../node_modules/flatpickr/dist/flatpickr.min.js', 'text/javascript']],
  ['/node_modules/flatpickr/dist/l10n/zh.js', ['../../node_modules/flatpickr/dist/l10n/zh.js', 'text/javascript']],
  ['/assets/icon.png', ['../../assets/icon.png', 'image/png']],
]);
const port = Number(process.env.PETDESK_DEMO_PORT || 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PETDESK_DEMO_PORT 应为 1024 至 65535 的整数');
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, {'Allow': 'GET, HEAD'}); response.end(); return; }
    if (pathname === '/') { response.writeHead(302, {'Location': '/docs/workbench/demo.html'}); response.end(); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const entry = files.get(pathname);
    if (!entry) { response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'}); response.end('Not found'); return; }
    const bytes = await readFile(fileURLToPath(new URL(entry[0], import.meta.url)));
    response.writeHead(200, {'Content-Type': `${entry[1]}${entry[1].startsWith('text/') ? '; charset=utf-8' : ''}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}); response.end('Preview unavailable'); }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '预览端口已被占用，请设置 PETDESK_DEMO_PORT 后重试。' : error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`PetDesk Demo: http://127.0.0.1:${port}/`));
