'use strict';
// Run the real main-process wiring with isolated Electron/recorder adapters.
// No browser, recorder, hardware, installed launcher or network is used.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
async function appFixture(t,{argv=[]}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vc-update-lifecycle-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const actions={},dialogs=[],responses=[],events=[];let recorder,surfaces,updater,win;
 class Recorder extends EventEmitter{constructor(){super();recorder=this;this.dataDir=dir;this.outputDir=dir;this.state={phase:'idle',settings:{camera:'none'},devices:{},elapsed:0};}async init(){}snapshot(){return this.state;}set(p){Object.assign(this.state,p);this.emit('state',this.state);}async refreshDevices(){}async dispose(){events.push('dispose');}idleOnly(){}async start(){events.push('record');}async stop(){events.push('stop');}}
 class Win extends EventEmitter{constructor(){super();win=this;this.webContents={mainFrame:{},send(){},setWindowOpenHandler(){},on(){},getURL:()=>'',session:{setPermissionRequestHandler(){}},executeJavaScript:async()=>{events.push('flush');await actions['capture:saveEdits']({sender:win.webContents,senderFrame:win.webContents.mainFrame},'fixture',[]);}};}isDestroyed(){return false;}isVisible(){return false;}isMinimized(){return false;}show(){}hide(){}focus(){}async loadFile(){}minimize(){}}
 class Surfaces{constructor(){surfaces=this;}busy(){return !!(this.updating||this.startPending||this.extensionMutation||['selecting','starting','recording','paused','stopping'].includes(recorder.state.phase)||recorder.state.job?.running);}update(){}syncLevel(){}async dispose(){events.push('surfaces-dispose');}async countdown(){return true;}async toggleRecording(){if(this.busy())return;events.push('hotkey-record');}}
 class Updates{constructor({changed}){updater=this;this.changed=changed;this.state={current:'0.1.0-alpha.8',available:'0.1.0-alpha.9',status:'available'};}async check(){return this.state;}async prepare(){events.push('prepare');this.installing=true;try{await this.prepareHook?.();this.ready={};this.state.status='ready';}finally{this.installing=false;}}async activate(){events.push('activate');await this.activateHook?.();return '/isolated/new-app';}}
 const Generic=class{async init(){}async load(){}async reconcile(){}async stop(){}start(){}async flush(){}async saveEdits(){events.push('save-edits');}dispose(){}async close(){}applyRenames(){return Promise.resolve();}};
 const app=new EventEmitter();Object.assign(app,{setName(){},setPath(){},getPath:()=>dir,requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),relaunch:o=>events.push(['relaunch',o]),quit:()=>events.push('quit')});
 const electron={app,BrowserWindow:Win,ipcMain:{handle:(name,handler)=>actions[name]=handler},Tray:class{setToolTip(){}setContextMenu(){}on(){}},Menu:{buildFromTemplate:x=>x},nativeImage:{createFromPath:()=>({resize(){return {};}})},dialog:{showMessageBox:async(_w,options)=>{dialogs.push(options);const response=responses.shift();return {response:typeof response==='function'?await response():response??0};},showErrorBox:(_t,e)=>events.push(['fatal',e])},shell:{},powerSaveBlocker:{},protocol:{registerSchemesAsPrivileged(){},handle(){}},clipboard:{}};
 const mocks={'electron':electron,'./updates.cjs':{Updates},'./desktop-links.cjs':require('../desktop-links.cjs'),'./recorder.cjs':{Recorder,ACTIVE:new Set(['selecting','starting','recording','paused','stopping'])},'./surfaces.cjs':{Surfaces},'./media.cjs':{MediaTools:Generic},'./transcript.cjs':{Transcripts:Generic},'./titles.cjs':{Titles:Generic},'./publisher.cjs':{Publisher:Generic},'./library.cjs':{Library:Generic},'./audio-chain.cjs':{AudioChain:Generic,ChainWatch:Generic,syncCleanup:async()=>{}},'./camera-settings.cjs':{CameraSettings:Generic},'./camera-effects.cjs':{CameraEffects:Generic},'./camera-profiles.cjs':{CameraProfiles:Generic},'./extension-bridge.cjs':{startExtensionBridge:async()=>new Generic()},'./hotkeys.cjs':{shortcutsFrom:()=>({})},'./autocopy.cjs':{createAutoCopy:()=>()=>{}}};
 const context={require:name=>mocks[name]||require(name),__dirname:path.resolve(__dirname,'..'),process:{env:{CAPTURE_TEST_DATA_DIR:dir,CAPTURE_TEST_BINDS:'[]'},argv,on(){},pid:process.pid},console,setTimeout,setInterval};
 vm.runInNewContext(await fs.readFile(path.join(__dirname,'../main.cjs'),'utf8'),context);
 for(let i=0;i<50&&!actions['capture:checkUpdates'];i++)await new Promise(r=>setTimeout(r,5));
 await new Promise(r=>setTimeout(r,10));assert.equal(events.some(e=>Array.isArray(e)&&e[0]==='fatal'),false,JSON.stringify(events));
 return {recorder,surfaces,updater,dialogs,responses,events,app,invoke:(name,...args)=>actions['capture:'+name]({sender:win.webContents,senderFrame:win.webContents.mainFrame},...args)};
}
test('update installation waits for recording, countdown, processing and extension mutations',async t=>{
 const f=await appFixture(t);
 for(const phase of ['selecting','starting','recording','paused','stopping']){f.recorder.state.phase=phase;await f.invoke('checkUpdates');}
 f.recorder.state.phase='idle';f.recorder.state.job={running:true};await f.invoke('checkUpdates');f.recorder.state.job=null;
 f.surfaces.startPending=true;await f.invoke('checkUpdates');f.surfaces.startPending=false;
 f.surfaces.picker={};await f.invoke('checkUpdates');f.surfaces.picker=null;
 f.surfaces.counting={};await f.invoke('checkUpdates');f.surfaces.counting=null;
 f.surfaces.extensionMutation=true;await f.invoke('checkUpdates');
 assert.equal(f.events.includes('prepare'),false);assert.equal(f.events.includes('stop'),false);
});
test('a recording started while the confirmation is open prevents installation',async t=>{
 const f=await appFixture(t);f.responses.push(()=>{f.recorder.state.phase='recording';return 1;});await f.invoke('checkUpdates');
 assert.equal(f.events.includes('prepare'),false);assert.match(f.dialogs.at(-1).detail,/Finish recording/);
});
test('installation blocks controls and quitting, then Later preserves the running version',async t=>{
 const f=await appFixture(t);let release;f.updater.prepareHook=()=>new Promise(r=>release=r);f.responses.push(1,0,0);
 const installing=f.invoke('checkUpdates');while(!release)await new Promise(r=>setTimeout(r,1));
 await assert.rejects(f.invoke('start'),/update/);await f.invoke('saveEdits','fixture',[]);assert.ok(f.events.includes('save-edits'));await f.invoke('close');assert.equal(f.events.includes('quit'),false);
 assert.equal(f.surfaces.busy(),true);release();await installing;
 assert.equal(f.events.includes('activate'),false);assert.equal(f.surfaces.updating,false);
});
test('Restart flushes edits and restarts through the new launcher',async t=>{
 const f=await appFixture(t);f.responses.push(1,1);await f.invoke('checkUpdates');
 assert.ok(f.events.indexOf('flush')<f.events.indexOf('activate'));
 assert.equal(f.events.at(-1),'quit');const relaunch=f.events.find(e=>Array.isArray(e)&&e[0]==='relaunch');assert.equal(relaunch[1].execPath,'/usr/bin/node');assert.equal(relaunch[1].args[0],'/isolated/new-app/launch.cjs');
});
test('a recording started while Restart confirmation is open prevents activation',async t=>{
 const f=await appFixture(t);f.responses.push(1,()=>{f.recorder.state.phase='recording';return 1;});await f.invoke('checkUpdates');
 assert.equal(f.events.includes('activate'),false);assert.equal(f.events.includes('stop'),false);assert.equal(f.events.includes('quit'),false);
});

test('an activation failure leaves the running recorder usable',async t=>{
 const f=await appFixture(t);f.responses.push(1,1);f.updater.activateHook=async()=>{throw new Error('disk is read only');};await f.invoke('checkUpdates');
 assert.equal(f.events.includes('quit'),false);assert.equal(f.events.includes('dispose'),false,'the recorder must not be disposed before activation can fail');
 assert.equal(f.surfaces.updating,false);
});

test('normal quit flushes pending edits through the real IPC gate',async t=>{
 const f=await appFixture(t);await f.invoke('close');
 assert.ok(f.events.includes('save-edits'));assert.equal(f.events.at(-1),'quit');
});
test('a prepared update can restart offline without a new check',async t=>{
 const f=await appFixture(t);f.updater.ready={};f.updater.state.status='ready';f.updater.check=async()=>{throw new Error('offline');};f.responses.push(1);await f.invoke('checkUpdates');
 assert.ok(f.events.includes('activate'));assert.equal(f.events.at(-1),'quit');
});

test('a concurrent background check is never reported as up to date',async t=>{
 const f=await appFixture(t);f.updater.state={current:'0.1.0-alpha.8',status:'checking',available:null};await f.invoke('checkUpdates');
 assert.equal(f.dialogs.at(-1).message,'Checking for updates');assert.equal(f.events.includes('prepare'),false);
 f.updater.state.status='idle';f.updater.checking=true;await f.invoke('checkUpdates');assert.equal(f.dialogs.at(-1).message,'Checking for updates');
});

test('website link opens the updater on cold start without installing',async t=>{
 const f=await appFixture(t,{argv:['app','--open-update-link','vidcapture://updates']});
 assert.match(f.dialogs.at(-1).message,/Update to VidCapture/);assert.equal(f.events.includes('prepare'),false);
});
test('website link reaches the running app and cannot start a recording',async t=>{
 const f=await appFixture(t);f.app.emit('second-instance',{},['electron','--ozone-platform=wayland','--open-update-link','--allow-file-access-from-files','/app','vidcapture://updates']);await new Promise(r=>setTimeout(r,10));
 assert.match(f.dialogs.at(-1).message,/Update to VidCapture/);assert.equal(f.events.includes('prepare'),false);
 const count=f.dialogs.length;f.app.emit('second-instance',{},['app','--open-update-link','vidcapture://updates','--toggle-recording']);await new Promise(r=>setTimeout(r,10));
 assert.equal(f.dialogs.length,count);assert.equal(f.events.includes('hotkey-record'),false);
});
test('website link during a take only reports availability and preserves recording',async t=>{
 const f=await appFixture(t);f.recorder.state.phase='recording';f.app.emit('second-instance',{},['app','--open-update-link','vidcapture://updates']);await new Promise(r=>setTimeout(r,10));
 assert.match(f.dialogs.at(-1).detail,/Finish recording/);assert.equal(f.events.includes('stop'),false);assert.equal(f.events.includes('prepare'),false);
});
