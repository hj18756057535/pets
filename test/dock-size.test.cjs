const test = require('node:test');
const assert = require('node:assert/strict');
const {dockSize,dockBounds,validateState,defaults} = require('../src/core.cjs');
test('不同分辨率和缩放使用逻辑尺寸，避免高 DPI 重复放大',()=>{
  const logical = (width,height,dpi) => ({width:width/dpi,height:height/dpi});
  assert.deepEqual(dockSize(logical(1920,1080,1)),dockSize(logical(3840,2160,2)));
  assert.deepEqual(dockSize(logical(1366,768,1)),{width:30,height:51});
  assert.deepEqual(dockSize(logical(2560,1440,1.5)),{width:34,height:58});
  assert.deepEqual(dockSize(logical(3840,2160,1)),{width:42,height:71});
  assert.deepEqual(dockSize({width:1080,height:1920}),dockSize({width:1920,height:1080}));
});
test('显示器尺寸变化保留相对高度，入口始终在可用区域内',()=>{
  for(const area of [{x:0,y:0,width:1366,height:728},{x:-1920,y:100,width:1920,height:1040}]) {
    for(const side of ['left','right']) {
      const b=dockBounds({side,y:999,centerRatio:.6},area);
      assert.ok(Math.abs((b.y+b.height/2-area.y)/area.height-.6)<.002);
      for(const centerRatio of [0,1]) {
        const edge=dockBounds({side,y:999,centerRatio},area);
        assert.ok(edge.x>=area.x && edge.x+edge.width<=area.x+area.width);
        assert.ok(edge.y>=area.y && edge.y+edge.height<=area.y+area.height);
      }
    }
  }
  const state=defaults(); state.dock={side:'left',displayId:'1',y:200,centerRatio:.6};
  assert.equal(validateState(state).dock.centerRatio,.6);
  delete state.dock.centerRatio; assert.equal(validateState(state).dock.y,200);
});
