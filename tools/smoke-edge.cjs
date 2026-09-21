const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const { dockSize } = require('../src/core.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
module.exports = async ({ panel, getPetWindow, root }) => {
  const api = code => panel.webContents.executeJavaScript(code);
  const area = screen.getDisplayMatching(getPetWindow().getBounds()).workArea;
  assert.equal(await getPetWindow().webContents.executeJavaScript(`document.querySelectorAll('#open, #fold').length`),0);
  await api(`window.petdesk.showPanel('settings')`);
  await getPetWindow().webContents.executeJavaScript(`document.getElementById('pet').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await delay(100);
  assert.equal(await panel.webContents.executeJavaScript(`document.getElementById('home').hidden`),false,'双击应打开陪伴空间');
  for (const side of ['left','right']) for (const scale of [.45,.6,1.2]) {
    await api(`window.petdesk.expandPet()`);
    await api(`window.petdesk.settings({scale:${scale}})`);
    getPetWindow().setPosition(side === 'left' ? area.x+60 : area.x+area.width-380,area.y+100);
    // Drive the same main-process drag IPC with deterministic cursor movement.
    const getCursor = screen.getCursorScreenPoint;
    let cursor = {x:area.x+area.width/2,y:area.y+200};
    screen.getCursorScreenPoint = () => cursor;
    try {
      await getPetWindow().webContents.executeJavaScript(`window.petdesk.dragStart()`);
      await delay(50);
      cursor = {x:cursor.x+(side === 'left' ? -area.width : area.width),y:cursor.y};
      await delay(80);
      await getPetWindow().webContents.executeJavaScript(`window.petdesk.dragEnd()`);
      await delay(100);
    } finally { screen.getCursorScreenPoint = getCursor; }
    const folded = getPetWindow().getBounds();
    const expected = dockSize(area);
    assert.ok(Math.abs(folded.width-expected.width)<=2 && Math.abs(folded.height-expected.height)<=2,'入口按当前屏幕自适应');
    assert.ok(folded.width<56 && folded.height<96,'收起尺寸应比旧版更小');
    assert.ok(await getPetWindow().webContents.executeJavaScript(`(()=>{const face=document.getElementById('edge-face').getBoundingClientRect(),arrow=document.getElementById('edge-arrow').getBoundingClientRect();return face.left>=0&&face.right<=innerWidth&&face.top>=0&&arrow.bottom<=innerHeight})()`),'头像和箭头应适配入口');
    if(scale===.6) fs.writeFileSync(path.join(root,'artifacts',`dock-${side}.png`),(await getPetWindow().webContents.capturePage()).toPNG());
    await api(`window.petdesk.expandPet()`); await delay(100);
    const bounds = getPetWindow().getBounds();
    const rect = await getPetWindow().webContents.executeJavaScript(`(()=>{const r=document.getElementById('pet').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height}})()`);
    const gap = side === 'left' ? bounds.x+rect.left-area.x : area.x+area.width-bounds.x-rect.right;
    assert.ok(Math.abs(gap-12)<1,`展开 ${side} ${scale} 应贴边，实际间距 ${gap}`);
    assert.ok(Math.abs(bounds.y+rect.top+rect.height/2-folded.y-folded.height/2)<2,'展开应保留宠物中心高度');
    if(scale===.6) fs.writeFileSync(path.join(root,'artifacts',`expanded-${side}.png`),(await getPetWindow().webContents.capturePage()).toPNG());
  }
  await api(`window.petdesk.settings({scale:.6})`);
  console.log('Edge smoke: PASS (left/right, three scales, visible gap, vertical anchor, adaptive dock).');
};
