// Record panel regression tests. Stubs electron and hyprctl/grim through
// child_process.execFile; never touches the real screen. Adapted from the
// November 6 correctness review's reproductions, asserting the fixed behavior.
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const cp=require('node:child_process');

// Fake hyprctl/grim. Each test sets `hypr` to a handler (args)=>stdout|Promise.
let hypr=()=>'[]';const calls=[];
cp.execFile=function(cmd,args,opts,cb){
  if(typeof opts==='function'){cb=opts;opts={};}
  calls.push([cmd,...args].join(' '));
  Promise.resolve().then(()=>cmd==='grim'?Buffer.from('jpg'):hypr(args)).then(out=>cb(null,{stdout:out,stderr:''}),e=>cb(e));
};

class FakeWin{
  constructor(o){this.o=o;this.destroyed=false;this.handlers={};this.webContents={sent:[],send:(c,d)=>this.webContents.sent.push([c,d]),setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};FakeWin.all.push(this);}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;(this.handlers.closed||[]).forEach(f=>f());}
  on(e,f){(this.handlers[e]||(this.handlers[e]=[])).push(f);}
  once(e,f){this.on(e,f);}
  loadFile(){return Promise.resolve();}
  show(){}showInactive(){}
}
FakeWin.all=[];
const ipc={};
const electron={BrowserWindow:Object.assign(FakeWin,{fromWebContents:()=>null}),ipcMain:{handle:(n,f)=>{ipc[n]=f;}}};
const origLoad=Module._load;
Module._load=function(req,...rest){if(req==='electron')return electron;return origLoad.call(this,req,...rest);};
const {Surfaces}=require('../surfaces.cjs');

const MON=[{name:'eDP-1',x:0,y:0,width:1920,height:1080,scale:1.5,transform:0,reserved:[0,26,0,0],activeWorkspace:{id:1},specialWorkspace:{id:0}}];
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function makeRecorder(over={}){
  const r={state:{phase:'idle',target:null,settings:{camera:'none'},devices:{microphones:[],cameras:[]},cameraPreview:false,error:null,job:null},
    snapshot(){return structuredClone(this.state);},set(d){Object.assign(this.state,d);},
    chooseTarget:async()=>{},start:async()=>{},previewCamera:async()=>{},...over};
  return r;
}


test('a resize requested before the panel is placed is applied once it is',async()=>{
  calls.length=0;hypr=async(args)=>{if(args[0]==='monitors')return JSON.stringify(MON);if(args[0]==='clients')return JSON.stringify([{address:'0xabc',at:[900,32]}]);return 'ok';};
  const s=new Surfaces({recorder:makeRecorder(),showMain(){},hideMain(){}});
  s.panel=new FakeWin({});s.panelRect={x:900,y:32,width:360,height:560,monitor:'eDP-1'};
  await s.resizePanel(430);
  assert.equal(s.panelWant,430,'request kept');
  assert.ok(!calls.some(c=>c.includes('window.resize')),'nothing dispatched before placement');
  s.panel.address='0xabc';await s.resizePanel(s.panelWant);
  assert.equal(s.panelRect.height,430);
});

test('overlapping resizes end at the newest height',async()=>{
  calls.length=0;let n=0;
  hypr=async(args)=>{if(args[0]==='monitors'){const k=n++;await delay(k===0?60:5);return JSON.stringify(MON);}if(args[0]==='clients')return JSON.stringify([{address:'0xabc',at:[900,32]}]);return 'ok';};
  const s=new Surfaces({recorder:makeRecorder(),showMain(){},hideMain(){}});
  s.panel=new FakeWin({});s.panel.address='0xabc';s.panelRect={x:900,y:32,width:360,height:560,monitor:'eDP-1'};
  await Promise.all([s.resizePanel(480),s.resizePanel(620)]);
  assert.equal(s.panelRect.height,620);
});

test('picking while processing refuses with the panel still open',async()=>{
  hypr=()=>JSON.stringify(MON);
  const rec=makeRecorder();rec.state.job={running:true};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  const p=new FakeWin({});s.panel=p;
  await assert.rejects(s.panelPick('area'),/processing/);
  assert.equal(p.isDestroyed(),false,'panel still open to show the error');
});

test('starting from the panel hides the main window, and restores it if the start fails',async()=>{
  let hidden=0,shown=0,visible=true;
  const rec=makeRecorder({start:async()=>{throw new Error('nope');}});rec.state.target={kind:'monitor',monitor:'eDP-1'};
  const s=new Surfaces({recorder:rec,showMain(){shown++;},hideMain(){hidden++;},mainVisible:()=>visible});
  s.ensurePanel=async()=>{};
  s.panel=new FakeWin({});
  await s.panelStart();
  assert.equal(hidden,1);assert.equal(shown,1);assert.equal(rec.state.error,'nope');
});

test('choosing a window on another workspace keeps the panel open and reports errors',async()=>{
  hypr=()=>'ok';
  const rec=makeRecorder({chooseTarget:async()=>{throw new Error('That window is no longer available. Choose it again.');}});
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  const p=new FakeWin({});s.panel=p;
  s.panelSnapshot={raw:[],windows:[{address:'0x1',visible:false}]};
  await assert.rejects(s.panelChoose({kind:'window',address:'0x1'}),/no longer available/);
  assert.equal(p.isDestroyed(),false);
});

test('a failed selection from a panel-started picker returns to the panel',async()=>{
  let shown=0;const rec=makeRecorder({chooseTarget:async()=>{throw new Error('Choose an area within one display.');}});
  const s=new Surfaces({recorder:rec,showMain(){shown++;},hideMain(){}});
  s.picker={intent:'select',origin:'panel',selection:{kind:'region',id:'region:0,0 100x100'}};
  let reopened=0;s.ensurePanel=async()=>{reopened++;};
  await s.confirm();
  assert.equal(shown,0);assert.equal(reopened,1);assert.match(rec.state.error,/one display/);
});

test('a second click while the panel is still opening closes it',async()=>{
  hypr=async(args)=>{if(args[0]==='monitors')return JSON.stringify(MON);if(args[0]==='clients')return '[]';if(args[0]==='cursorpos')return '{"x":10,"y":10}';return 'ok';};
  const rec=makeRecorder();rec.state.target={kind:'monitor',monitor:'eDP-1'};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  const before=FakeWin.all.length;
  await Promise.all([s.openPanel({}),s.openPanel({})]);
  assert.ok(!s.panel||s.panel.isDestroyed(),'panel closed');
  assert.ok(FakeWin.all.length-before<=1);
});

test('internal reopen never closes an open panel',async()=>{
  const s=new Surfaces({recorder:makeRecorder(),showMain(){},hideMain(){}});
  const p=new FakeWin({});s.panel=p;
  await s.ensurePanel({});
  assert.equal(p.isDestroyed(),false);
});

test('a camera that cannot fit the area is refused before the panel closes',async()=>{
  let started=0;
  const rec=makeRecorder({start:async()=>{started++;}});
  rec.state.settings.camera='/dev/video0';rec.state.target={kind:'region',x:10,y:40,width:40,height:40};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},mainVisible:()=>false});
  const p=new FakeWin({});s.panel=p;
  s.panelSnapshot={raw:[{id:'eDP-1',x:0,y:0,width:1280,height:720,scale:1.5}]};
  await assert.rejects(s.panelStart(),/at least 136 × 136 to fit the camera/);
  assert.equal(p.isDestroyed(),false,'panel stays open');assert.equal(started,0);
});

test('switching back to Area restores the drawn area through the recorder',async()=>{
  hypr=()=>JSON.stringify(MON);
  const chosen=[];const rec=makeRecorder({chooseTarget:async(id)=>{chosen.push(id);}});
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  s.panelSnapshot={monitors:[],windows:[],raw:[]};
  await s.panelChoose({kind:'region',x:700,y:200,width:402,height:282});
  assert.deepEqual(chosen,['region:700,200 402x282']);
  await assert.rejects(s.panelChoose({kind:'region',x:'a',y:0,width:10,height:10}),/Draw the area again/);
});

test('saving a setting clears an old error, and area sizes are reported in saved pixels',async()=>{
  const rec=makeRecorder({saveSettings:async()=>{}});rec.state.error='Choose a larger recording area to fit the camera.';
  rec.state.target={kind:'region',x:100,y:100,width:300,height:180};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  s.panelSnapshot={monitors:[],windows:[],raw:[{id:'eDP-1',x:0,y:0,width:1280,height:720,scale:1.5}]};
  const out=await s.panelSave({camera:'none'});
  assert.equal(out.error,null);
  assert.deepEqual(s.panelState(false).targetSize,{width:450,height:270});
});

test('a failed start reopens the panel with its message; a user open starts clean',async()=>{
  const rec=makeRecorder({start:async()=>{rec.state.phase='error';throw new Error('Not enough free space.');}});
  rec.state.target={kind:'monitor',monitor:'eDP-1',width:1280,height:720};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},mainVisible:()=>false});
  let opened=0;s._openPanel=async()=>{opened++;};
  s.panel=new FakeWin({});
  await s.panelStart();
  assert.equal(opened,1);assert.equal(rec.state.error,'Not enough free space.');
  assert.equal(s.busy(),false,'start flag cleared');
  s.panel=null;await s.togglePanel({});
  assert.equal(rec.state.error,null);
});

test('a choice waits for the default display chosen at open',async()=>{
  const order=[];let release;
  const rec=makeRecorder({chooseTarget:async(id)=>{order.push(id);}});
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  s.panelSnapshot={monitors:[],windows:[],raw:[{id:'eDP-1'},{id:'DP-7'}]};
  s.panelDefault=new Promise(r=>{release=r;}).then(()=>order.push('default'));
  const p=s.panelChoose({kind:'monitor',id:'DP-7'});
  await delay(10);assert.deepEqual(order,[]);
  release();await p;
  assert.deepEqual(order,['default','DP-7']);
});

test('a failed choice brings the camera preview back',async()=>{
  let previews=0;
  const rec=makeRecorder({chooseTarget:async()=>{rec.state.cameraPreview=false;throw new Error('gone');},previewCamera:async()=>{previews++;rec.state.cameraPreview=true;}});
  rec.state.cameraPreview=true;rec.state.settings.camera='/dev/video0';
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  s.raisePanel=async()=>{};
  s.panelSnapshot={monitors:[],windows:[],raw:[{id:'eDP-1'}]};
  await assert.rejects(s.panelChoose({kind:'monitor',id:'eDP-1'}),/gone/);
  assert.equal(previews,1);
});

test('a closed target window is refused before the panel closes',async()=>{
  let started=0;
  const rec=makeRecorder({start:async()=>{started++;}});
  rec.state.target={kind:'window',address:'0xdead',available:false,x:0,y:0,width:600,height:400};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},mainVisible:()=>false});
  const p=new FakeWin({});s.panel=p;
  await assert.rejects(s.panelStart(),/window was closed/);
  assert.equal(p.isDestroyed(),false);assert.equal(started,0);
});

test('returning from a picker lands on the tab it was opened from',async()=>{
  hypr=()=>JSON.stringify(MON);
  const s=new Surfaces({recorder:makeRecorder(),showMain(){},hideMain(){},mainVisible:()=>false});
  s.openPicker=async()=>{};
  await s.panelPick('window');
  assert.equal(s.panelState(false).tab,'window');
  s._openPanel=async()=>{};await s.togglePanel({});
  assert.equal(s.panelState(false).tab,null,'a fresh open follows the target');
});

test('the countdown can be canceled, and a canceled start never records',async()=>{
  hypr=async(args)=>{if(args[0]==='monitors')return JSON.stringify(MON);if(args[0]==='clients')return '[]';return 'ok';};
  let started=0,reopened=0;
  const rec=makeRecorder({start:async()=>{started++;}});
  rec.state.settings.countdown=3;rec.state.target={kind:'monitor',monitor:'eDP-1',x:0,y:0,width:1280,height:720};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},mainVisible:()=>false});
  s.ensurePanel=async()=>{reopened++;};
  s.panel=new FakeWin({});
  const run=s.panelStart();
  await delay(80);
  assert.ok(s.counting,'countdown showing');assert.equal(s.busy(),true,'busy during the countdown');
  s.closeCountdown();
  await run;
  assert.equal(started,0);assert.equal(reopened,1);assert.equal(s.busy(),false);
});

test('no countdown when it is off',async()=>{
  const rec=makeRecorder();rec.state.settings.countdown=0;rec.state.target={kind:'monitor',monitor:'eDP-1',x:0,y:0,width:10,height:10};
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  assert.equal(await s.countdown(),true);assert.equal(s.counting,undefined);
});

test('the corner dot is skipped when the top bar icon is installed',async()=>{
  const fsx=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fsx.mkdtempSync(path.join(os.tmpdir(),'vc-bar-'));fsx.mkdirSync(path.join(dir,'omarchy'));
  const old=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=dir;
  try{
    const s=new Surfaces({recorder:makeRecorder(),showMain(){},hideMain(){}});
    fsx.writeFileSync(path.join(dir,'omarchy','shell.json'),'{"bar":{"right":[{"id":"omarchy.clock"}]}}');
    assert.equal(await s.barIcon(),false);
    s.barIconCache=null;
    fsx.writeFileSync(path.join(dir,'omarchy','shell.json'),'{"bar":{"right":[{"id": "someone.vidcapture"}]}}');
    assert.equal(await s.barIcon(),true);
  }finally{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;fsx.rmSync(dir,{recursive:true,force:true});}
});

test('the microphone level is not read while busy or with no microphone',()=>{
  const rec=makeRecorder();rec.state.settings.microphone='none';
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});
  s.panel=new FakeWin({});
  s.syncLevel();assert.equal(s.level,undefined);
  rec.state.settings.microphone='default_input';rec.state.phase='recording';
  s.syncLevel();assert.equal(s.level,undefined);
});

test('saving settings from the panel brings the live mic chain along',async()=>{
  const saved=[];let synced=0;
  const rec=makeRecorder({saveSettings:async p=>{saved.push(p);Object.assign(rec.state.settings,p);}});
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},onSettings:async()=>{synced++;assert.equal(rec.state.settings.mic,'demo-mic','sync sees the new mic');}});
  s.panelState=()=>({});
  await s.panelSave({mic:'demo-mic'});
  assert.deepEqual(saved,[{mic:'demo-mic'}]);assert.equal(synced,1);
});

test('the panel state carries a microphone cleanup failure, and Try again reruns the sync',async()=>{
  let synced=0;
  const rec=makeRecorder();rec.state.micCleanupError='Microphone cleanup did not start in time.';
  const s=new Surfaces({recorder:rec,showMain(){},hideMain(){},onSettings:async()=>{synced++;rec.state.micCleanupError=null;}});
  assert.equal(s.panelState(false).micCleanupError,'Microphone cleanup did not start in time.');
  const after=await s.panelRetryMic();
  assert.equal(synced,1);assert.equal(after.micCleanupError,null,'cleared after a successful recovery');
  rec.state.phase='recording';
  await assert.rejects(s.panelRetryMic(),/Stop and save this recording first/);assert.equal(synced,1,'never during a take');
});


test('panel start rechecks a browser settings lock after waiting for the default source',async()=>{
 const rec=makeRecorder();rec.state.target={kind:'monitor',width:1280,height:720};
 const s=new Surfaces({recorder:rec,showMain(){},hideMain(){}});let release,counts=0;
 s.settled=()=>new Promise(resolve=>{release=resolve;});s.countdown=async()=>{counts++;return false;};
 const pending=s.panelStart();s.extensionMutation=true;release();
 await assert.rejects(pending,/Wait for the current recording action/);assert.equal(counts,0);assert.equal(s.startPending,undefined);
});
