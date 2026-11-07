const {test}=require('node:test');
const assert=require('node:assert/strict');
const G=require('../ui/geometry.js');

// Cameron's layout: 1920x1080 laptop at 1.5 scale beside a 3440x1440 display.
const raw=[
  {name:'eDP-1',x:0,y:0,width:1920,height:1080,scale:1.5,transform:0,reserved:[0,26,0,0],activeWorkspace:{id:3},specialWorkspace:{id:0}},
  {name:'DP-7',x:1280,y:0,width:3440,height:1440,scale:1,transform:0,reserved:[0,26,0,0],activeWorkspace:{id:2},specialWorkspace:{id:0}},
];
const monitors=raw.map(G.logicalMonitor);
const client=(o)=>({mapped:true,hidden:false,visible:true,class:'editor',title:'Doc',floating:false,pinned:false,fullscreen:0,focusHistoryID:5,workspace:{id:3},at:[0,0],size:[400,300],...o});

test('monitors convert to logical size, rotation, reserved space, and built-in detection',()=>{
  assert.deepEqual([monitors[0].width,monitors[0].height,monitors[0].internal],[1280,720,true]);
  assert.deepEqual([monitors[1].width,monitors[1].height,monitors[1].internal],[3440,1440,false]);
  assert.equal(monitors[0].reserved.top,26);
  const portrait=G.logicalMonitor({name:'DP-2',x:0,y:0,width:2560,height:1440,scale:2,transform:1});
  assert.deepEqual([portrait.width,portrait.height],[720,1280]);
});

test('window hit-testing uses visible workspaces, skips VidCapture, and prefers the top window',()=>{
  const tiled=client({address:'0x1',at:[0,26],size:[1280,694],focusHistoryID:1});
  const floating=client({address:'0x2',at:[100,100],size:[500,400],floating:true,focusHistoryID:3});
  const hidden=client({address:'0x3',workspace:{id:9},at:[0,0],size:[1280,720],focusHistoryID:0});
  const own=client({address:'0x4',class:'capture',at:[0,0],size:[1280,720],floating:true,focusHistoryID:0});
  const camera=client({address:'0x5',class:'capture-camera',at:[200,200],size:[100,100],pinned:true});
  const pinnedElsewhere=client({address:'0x6',workspace:{id:7},pinned:true,at:[1300,40],size:[300,300]});
  const external=client({address:'0x7',workspace:{id:2},at:[1280,26],size:[1720,1414]});
  const windows=G.visibleWindows([tiled,floating,hidden,own,camera,pinnedElsewhere,external],monitors);
  assert.deepEqual(windows.map(w=>w.address).sort(),['0x1','0x2','0x6','0x7']);
  assert.equal(G.windowAt(windows,150,150).address,'0x2');
  assert.equal(G.windowAt(windows,900,400).address,'0x1');
  assert.equal(G.windowAt(windows,1350,100).address,'0x6');
  assert.equal(G.windowAt(windows,2000,800).address,'0x7');
  assert.equal(G.windowAt(windows,640,10),null);
  // Among overlapping floating windows, the most recently focused wins.
  const a=client({address:'0xa',floating:true,at:[0,0],size:[300,300],focusHistoryID:4});
  const b=client({address:'0xb',floating:true,at:[100,100],size:[300,300],focusHistoryID:2});
  assert.equal(G.windowAt(G.visibleWindows([a,b],monitors),150,150).address,'0xb');
});

test('special workspace windows sit above the regular workspace',()=>{
  const ms=[G.logicalMonitor({...raw[0],specialWorkspace:{id:-98}})];
  const regular=client({address:'0x1',floating:true,at:[0,26],size:[1280,694],focusHistoryID:0});
  const scratch=client({address:'0x2',workspace:{id:-98},at:[100,100],size:[600,400],focusHistoryID:4});
  assert.equal(G.windowAt(G.visibleWindows([regular,scratch],ms),300,300).address,'0x2');
});

test('dragged areas map to logical layout coordinates snapped to whole physical pixels',()=>{
  const laptop=monitors[0],wide=monitors[1];
  assert.equal(G.scaleStep(1),1);assert.equal(G.scaleStep(1.5),2);assert.equal(G.scaleStep(1.25),4);assert.equal(G.scaleStep(2),1);
  const r=G.dragRect({x:301,y:155},{x:101,y:55},laptop);
  assert.deepEqual(r,{x:100,y:54,width:202,height:102});
  const p=G.physicalSize(r,laptop.scale);
  assert.ok(Number.isInteger(r.x*1.5)&&Number.isInteger(r.width*1.5));
  assert.deepEqual(p,{width:304,height:154});
  // Drags past the display edge clamp to that display.
  assert.deepEqual(G.dragRect({x:1200,y:600},{x:1500,y:900},laptop),{x:1200,y:600,width:80,height:120});
  assert.deepEqual(G.dragRect({x:1281,y:10},{x:1500,y:300},wide),{x:1281,y:10,width:219,height:290});
  assert.equal(G.dragRect({x:10,y:10},{x:30,y:200},laptop),null);
  assert.equal(G.regionId({x:1281,y:10,width:219,height:290}),'region:1281,10 219x290');
});

test('region ids round-trip through the recorder parser',()=>{
  const {parseRegion}=require('../recorder.cjs');
  const r=G.dragRect({x:40,y:60},{x:840,y:560},monitors[0]);
  assert.deepEqual(parseRegion(G.regionId(r).slice(7)),{kind:'region',...r,label:`Selected area (${r.width} × ${r.height})`});
});

const PILL={width:212,height:44};
const overlaps=(a,b)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;

test('controls go beside a window or area on the same display when there is room',()=>{
  const target={kind:'region',x:200,y:100,width:600,height:400};
  const spot=G.pillPlacement({target,monitors,pill:PILL});
  assert.equal(spot.monitor,'eDP-1');assert.equal(spot.collapsed,false);
  assert.ok(!overlaps(spot,target));
  assert.deepEqual([spot.x,spot.y],[394,516]);
  // A crop that reaches the bottom puts the controls above it, below the bar.
  const low={kind:'window',x:100,y:300,width:900,height:408};
  const above=G.pillPlacement({target:low,monitors,pill:PILL});
  assert.ok(!overlaps(above,low));assert.ok(above.y>=26);assert.equal(above.monitor,'eDP-1');
});

test('controls move to another display when the crop fills its display',()=>{
  const target={kind:'window',x:0,y:26,width:1280,height:694};
  const spot=G.pillPlacement({target,monitors,pill:PILL});
  assert.equal(spot.monitor,'DP-7');assert.equal(spot.collapsed,false);
  assert.ok(spot.x>=1280&&spot.x+PILL.width<=1280+3440);
});

test('full display recordings use another display, or fold to a corner dot when alone',()=>{
  const external={kind:'monitor',monitor:'DP-7',x:1280,y:0,width:3440,height:1440};
  assert.equal(G.pillPlacement({target:external,monitors,pill:PILL}).monitor,'eDP-1');
  const laptop={kind:'monitor',monitor:'eDP-1',x:0,y:0,width:1280,height:720};
  assert.equal(G.pillPlacement({target:laptop,monitors,pill:PILL}).monitor,'DP-7');
  const alone=G.pillPlacement({target:laptop,monitors:[monitors[0]],pill:PILL,cameraCorner:'bottom-right'});
  assert.deepEqual(alone,{x:12,y:680,width:28,height:28,monitor:'eDP-1',collapsed:true,recorded:true});
  const right=G.pillPlacement({target:laptop,monitors:[monitors[0]],pill:PILL,cameraCorner:'bottom-left'});
  assert.equal(right.x,1280-12-28);
  const open=G.expandFromDot(right,PILL,monitors[0]);
  assert.equal(open.x+open.width,right.x+right.width);assert.equal(open.y+open.height,right.y+right.height);
});

test('launcher bar sits top center on the built-in display below its bar',()=>{
  assert.deepEqual(G.barPlacement(monitors[0],{width:392,height:52}),{x:444,y:38,width:392,height:52});
});
