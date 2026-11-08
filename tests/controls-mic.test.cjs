// Wiring of the microphone indicator into the recording controls, and the idle meter's
// reader lifecycle. Stubs electron, hyprctl and the level reader; never touches the
// screen or an audio device.
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const cp=require('node:child_process');
const {EventEmitter}=require('node:events');

cp.execFile=function(cmd,args,opts,cb){if(typeof opts==='function'){cb=opts;opts={};}Promise.resolve().then(()=>cb(null,{stdout:'[]',stderr:''}));};
const spawned=[];
cp.spawn=(cmd,args)=>{const c=new EventEmitter();c.cmd=cmd;c.args=args;c.stdout=new EventEmitter();c.killed=false;c.kill=()=>{c.killed=true;};spawned.push(c);return c;};

class FakeWin{
  constructor(o){this.o=o;this.destroyed=false;this.handlers={};this.webContents={sent:[],send:(c,d)=>this.webContents.sent.push([c,d]),setWindowOpenHandler(){},on(){},session:{setPermissionRequestHandler(){}}};}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;(this.handlers.closed||[]).forEach(f=>f());}
  on(e,f){(this.handlers[e]||(this.handlers[e]=[])).push(f);}
  once(e,f){this.on(e,f);}
}
const ipc={};
const electron={BrowserWindow:Object.assign(FakeWin,{fromWebContents:()=>null}),ipcMain:{handle:(n,f)=>{ipc[n]=f;}}};
const origLoad=Module._load;
Module._load=function(req,...rest){if(req==='electron')return electron;return origLoad.call(this,req,...rest);};
const {Surfaces}=require('../surfaces.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

function fakeMeter(){const m={calls:[],sync(t){m.calls.push(['sync',t]);},stop(){m.calls.push(['stop']);},snapshot(){return {state:'quiet',level:0};}};return m;}
function setup(over={}){
  const recorder={state:{phase:'idle',target:null,settings:{microphone:'alsa_input.usb',camera:'none'},devices:{microphones:[],cameras:[]},error:null,job:null},
    child:{pid:4242},takeAudio:{micSource:'vidcapture_mic'},snapshot(){return structuredClone(this.state);},set(d){Object.assign(this.state,d);},...over};
  const meter=fakeMeter();
  const s=new Surfaces({recorder,showMain(){},hideMain(){},takeMeter:meter});
  s.noControls=true;// keep update() from opening real controls
  return {s,recorder,meter};
}

test('the indicator follows the take while the controls are open, and stops with them',()=>{
  const {s,recorder,meter}=setup();
  recorder.state.phase='recording';
  s.update(recorder.state);
  assert.deepEqual(meter.calls.at(-1),['stop'],'no controls yet, nothing runs');
  const win=new FakeWin({});s.controls=win;
  s.update(recorder.state);
  assert.deepEqual(meter.calls.at(-1),['sync',{pid:4242,phase:'recording',expect:'vidcapture_mic',micNone:false}]);
  recorder.state.phase='paused';s.update(recorder.state);
  assert.equal(meter.calls.at(-1)[1].phase,'paused');
  // Stop closes the controls, which ends the meter.
  s.closeControls();
  assert.deepEqual(meter.calls.at(-1),['stop']);
  recorder.state.phase='stopping';s.controls=new FakeWin({});s.update(recorder.state);
  assert.deepEqual(meter.calls.at(-1),['stop'],'stopping is not live');
});

test('a take with no microphone is passed as such, and updates reach only the controls window',async()=>{
  const {s,recorder,meter}=setup({takeAudio:{micSource:null}});
  recorder.state.phase='recording';recorder.state.settings.microphone='none';
  const win=new FakeWin({});s.controls=win;s.update(recorder.state);
  assert.equal(meter.calls.at(-1)[1].micNone,true);
  s.sendMic({state:'live',level:0.5});
  assert.deepEqual(win.webContents.sent.filter(([c])=>c==='vc:mic'),[['vc:mic',{state:'live',level:0.5}]]);
  win.destroy();s.sendMic({state:'live',level:0.6});
  assert.equal(win.webContents.sent.filter(([c])=>c==='vc:mic').length,1,'nothing is sent to a closed window');
  meter.drain=async()=>{meter.calls.push(['drain']);return {unconfirmed:[31337]};};
  const disposed=s.dispose();assert.ok(disposed&&typeof disposed.then==='function','dispose can be awaited');
  assert.deepEqual(meter.calls.slice(-2),[['stop'],['drain']]);
  assert.deepEqual(await disposed,{unconfirmed:[31337]},'the unconfirmed outcome reaches the caller');
});

test('the panel meter stops its timer when its reader exits on its own',async()=>{
  const {s,recorder}=setup();
  const panel=new FakeWin({});s.panel=panel;s.busy=()=>false;
  s.syncLevel();
  const reader=spawned.at(-1);assert.equal(reader.cmd,'parec');
  reader.emit('exit',1);
  assert.equal(s.level,null);
  const before=panel.webContents.sent.length;
  await delay(250);
  const late=panel.webContents.sent.slice(before).filter(([c])=>c==='vc:level');
  assert.deepEqual(late,[],'no levels are sent for a reader that is gone');
  s.closePanel=()=>{};s.panel=null;
});

test('the panel meter joins samples split across chunks',async()=>{
  const {s}=setup();
  const panel=new FakeWin({});s.panel=panel;s.busy=()=>false;
  s.syncLevel();
  const reader=spawned.at(-1);
  // One loud sample, split between two chunks.
  reader.stdout.emit('data',Buffer.from([0x00]));reader.stdout.emit('data',Buffer.from([0x40]));
  await delay(120);
  const levels=panel.webContents.sent.filter(([c])=>c==='vc:level').map(([,v])=>v);
  assert.ok(levels.some(v=>v>0.8),'0x4000 is about -6 dBFS');
  s.stopLevel();s.panel=null;
});

test('quitting reports a reader exit it could not confirm instead of assuming it',()=>{
  const main=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','main.cjs'),'utf8');
  const close=main.slice(main.indexOf('async function requestClose'),main.indexOf("app.on('before-quit'"));
  assert.match(close,/const meterEnd=await surfaces\?\.dispose\(\);/);
  assert.match(close,/if\(meterEnd\?\.unconfirmed\?\.length\)console\.error\(/);
  assert.ok(close.indexOf('meterEnd')<close.indexOf('app.quit()'),'quitting goes on afterwards');
});
