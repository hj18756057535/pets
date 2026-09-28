const test = require('node:test');
const assert = require('node:assert/strict');
const {petLayout} = require('../src/pet-layout.cjs');
test('以宠物位置约束边界，主屏副屏顶部均可到达，气泡换到下方',()=>{
  for(const area of [{x:0,y:0,width:1920,height:1040},{x:-1707,y:-960,width:1707,height:920},{x:1920,y:200,width:1366,height:728}]) {
    for(const scale of [.45,.6,1.2]) {
      const top=petLayout({x:area.x+300,y:area.y-100},scale,area);
      assert.equal(top.bounds.y+top.offset.y,area.y); assert.equal(top.below,true);
      const bottom=petLayout({x:area.x+10000,y:area.y+10000},scale,area);
      assert.equal(bottom.below,false);
      assert.ok(Math.abs(bottom.anchor.y+156*scale-area.y-area.height)<.001);
      assert.ok(bottom.bounds.x>=area.x && bottom.bounds.x+bottom.bounds.width<=area.x+area.width);
      assert.ok(bottom.bounds.y>=area.y && bottom.bounds.y+bottom.bounds.height<=area.y+area.height);
    }
  }
});
