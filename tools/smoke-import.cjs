const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { dialog } = require('electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) { const deadline = Date.now() + 55000; while (Date.now() < deadline) { if (await fn()) return; await delay(100); } throw new Error(message); }
module.exports = async ({ panel, getPetWindow, store, root, dataDir }) => {
  const web = panel.webContents, originalDialog = dialog.showOpenDialog;
  let selectedFile = process.env.PETDESK_TEST_ZIP;
  const artifacts = path.join(root, 'artifacts');
  dialog.showOpenDialog = async (_parent, options) => { assert.deepEqual(options.properties, ['openFile']); assert.deepEqual(options.filters[0].extensions, ['zip']); return { canceled: false, filePaths: [selectedFile] }; };
  try {
    await web.executeJavaScript(`window.petdesk.dockPet()`);
    const before = store.snapshot();
    const originalName = await web.executeJavaScript('(async()=> (await window.petdesk.init()).pet.name)()');
    await web.executeJavaScript(`document.querySelector('[data-tab="home"]').click(); document.getElementById('import-pet').click(); document.getElementById('import-zip').click()`);
    await until(() => web.executeJavaScript(`!document.getElementById('import-apply').disabled`), 'ZIP 预览失败');
    assert.equal(await web.executeJavaScript(`document.getElementById('import-name').textContent`), 'Doge');
    assert.equal(await web.executeJavaScript('(async()=> (await window.petdesk.init()).pet.name)()'), originalName, '预览不应改变当前宠物');
    fs.writeFileSync(path.join(artifacts, 'import-zip.png'), (await web.capturePage()).toPNG());
    await web.executeJavaScript(`document.getElementById('import-apply').click()`);
    await until(() => web.executeJavaScript(`!document.getElementById('import-dialog').open && document.getElementById('pet-name').textContent === 'Doge'`), 'ZIP 确认导入失败');
    assert.deepEqual(store.snapshot(), before, '导入不能改变提醒、尺寸或侧边状态');
    const originalSelection = fs.readFileSync(path.join(dataDir, 'selected-pet.json'), 'utf8');
    selectedFile = path.join(dataDir, 'broken.zip'); fs.writeFileSync(selectedFile, 'broken zip');
    await web.executeJavaScript(`document.getElementById('import-pet').click(); document.getElementById('import-zip').click()`);
    await until(() => web.executeJavaScript(`!document.getElementById('import-error').hidden`), '损坏 ZIP 没有显示错误');
    assert.equal(fs.readFileSync(path.join(dataDir, 'selected-pet.json'), 'utf8'), originalSelection);
    assert.equal(await web.executeJavaScript(`document.getElementById('import-apply').disabled`), true);
    await web.executeJavaScript(`document.getElementById('import-close').click()`);
    if (process.env.PETDESK_TEST_SHARE) {
      await web.executeJavaScript(`document.getElementById('import-pet').click(); document.getElementById('import-url').value = ${JSON.stringify(process.env.PETDESK_TEST_SHARE)}; document.getElementById('import-link-form').requestSubmit()`);
      await until(() => web.executeJavaScript(`!document.getElementById('import-apply').disabled || !document.getElementById('import-error').hidden`), '分享链接没有完成读取');
      assert.equal(await web.executeJavaScript(`document.getElementById('import-error').hidden ? '' : document.getElementById('import-error').textContent`), '');
      assert.equal(await web.executeJavaScript(`document.getElementById('import-name').textContent`), '铁包金 · Dog 狗');
      fs.writeFileSync(path.join(artifacts, 'import-share.png'), (await web.capturePage()).toPNG());
      await web.executeJavaScript(`document.getElementById('import-apply').click()`);
      await until(() => web.executeJavaScript(`!document.getElementById('import-dialog').open && document.getElementById('pet-name').textContent === '铁包金 · Dog 狗'`), '分享链接确认导入失败');
      assert.deepEqual(store.snapshot(), before);
      const selection = JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-pet.json'), 'utf8'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, selection.directory, 'pet.json'), 'utf8')).spriteVersionNumber, 2);
    }
    await until(() => getPetWindow().webContents.executeJavaScript('window.__ready === true'), '更换后桌宠未加载');
    assert.equal(await getPetWindow().webContents.executeJavaScript('document.body.classList.contains("docked")'), true);
    console.log('Import smoke: PASS (ZIP preview/apply, broken ZIP rollback, live share link, preserved reminders/size/dock).');
  } finally { dialog.showOpenDialog = originalDialog; }
};
