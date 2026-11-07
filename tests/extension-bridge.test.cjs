const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const {startExtensionBridge}=require('../extension-bridge.cjs');
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vc-bridge-'));
 const r=new EventEmitter();r.dataDir=dir;r.state={phase:'idle',elapsed:0,settings:{camera:'none'},devices:{cameras:[],microphones:[],monitors:[{id:'eDP-1'}]},recent:[],lastFile:'/private/recording.mp4',secret:'must not escape'};
 r.snapshot=()=>structuredClone(r.state);r.idleOnly=()=>{if(['recording','paused','starting'].includes(r.state.phase))throw new Error('Recording is in progress.');};r.listWindows=async()=>[];
 let pauseCount=0,startCount=0,openCount=0;
 r.pause=async()=>{pauseCount++;r.state.phase=r.state.phase==='paused'?'recording':'paused';};
 r.stop=async()=>{r.state.phase='saved';};r.chooseTarget=async id=>{r.state.target={kind:'monitor',monitor:id};};
 r.openCamera=async()=>{openCount++;r.camera={pid:123};};r.closeCamera=async()=>{r.camera=null;};
 const actions={start:async()=>{startCount++;await new Promise(r=>setTimeout(r,35));r.state.phase='recording';},saveSettings:async s=>{r.idleOnly();Object.assign(r.state.settings,s);},openLibrary:async()=>{}};
 const bridge=await startExtensionBridge({recorder:r,actions,surfaces:{openPicker:async()=>{}},show(){}});
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 return {r,bridge,dir,counts:()=>({pauseCount,startCount,openCount})};
}
test('status is sanitized and the control socket is private',async t=>{
 const {bridge,dir}=await fixture(t),s=await bridge.execute({id:'status-001',action:'status'});
 assert.equal(s.secret,undefined);assert.deepEqual(s.saved,{name:'recording.mp4'});assert.equal(JSON.stringify(s).includes('/private'),false);
 assert.equal((await fs.stat(path.join(dir,'extension.sock'))).mode&0o777,0o600);
});
test('replayed start is executed once; simultaneous mutations are refused',async t=>{
 const {bridge,counts}=await fixture(t),m={id:'start-001',action:'start'};
 const a=bridge.execute(m),b=bridge.execute(m);
 assert.equal((await bridge.execute({id:'status-002',action:'status'})).pending,'start');
 await assert.rejects(bridge.execute({id:'preview-001',action:'preview',enabled:true}),/Wait/);
 await Promise.all([a,b]);assert.equal(counts().startCount,1);
 await assert.rejects(bridge.execute({id:'start-001',action:'stop'}),/reused/);
});
test('pause and resume express desired states, never toggle twice on retries',async t=>{
 const {r,bridge,counts}=await fixture(t);r.state.phase='recording';
 await bridge.execute({id:'pause-001',action:'pause'});await bridge.execute({id:'pause-002',action:'pause'});
 assert.equal(r.state.phase,'paused');assert.equal(counts().pauseCount,1);
 await bridge.execute({id:'resume-001',action:'resume'});await bridge.execute({id:'resume-002',action:'resume'});
 assert.equal(r.state.phase,'recording');assert.equal(counts().pauseCount,2);
});
test('unrecognized commands and settings are rejected',async t=>{
 const {bridge}=await fixture(t);
 await assert.rejects(bridge.execute({id:'unknown-1',action:'upload'}),/Unknown/);
 await assert.rejects(bridge.execute({id:'config-01',action:'configure',settings:{outputDir:'/tmp'}}),/Invalid/);
 await assert.rejects(bridge.execute({id:'select-01',action:'select',target:'region:0,0 500x500'}),/Choose/);
});
test('disconnecting a caller does not cancel a recording command',async t=>{
 const {bridge,dir,r}=await fixture(t);
 const c=net.createConnection(path.join(dir,'extension.sock'));
 await new Promise(resolve=>c.once('connect',resolve));c.write(JSON.stringify({id:'start-disconnect',action:'start'})+'\n');
 await new Promise(resolve=>setTimeout(resolve,10));c.destroy();await new Promise(resolve=>setTimeout(resolve,60));
 assert.equal(r.state.phase,'recording');assert.equal(bridge.state().pending,null);
});
test('a native port handles fragmented and multiple messages with correlated responses',async t=>{
 const {dir}=await fixture(t);
 const child=spawn(path.resolve('extension/native/vidcapture-native-host'),['chrome-extension://dagpaflngbhbgpeichcnhalplkdmkfie/'],{env:{...process.env,VIDCAPTURE_SOCKET:path.join(dir,'extension.sock')},stdio:['pipe','pipe','pipe']});
 t.after(()=>child.kill());
 const frame=m=>{const b=Buffer.from(JSON.stringify(m)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);return Buffer.concat([h,b]);};
 const data=Buffer.concat([frame({id:'native-001',action:'status'}),frame({id:'native-002',action:'status'})]);
 const replies=[];let buffer=Buffer.alloc(0);
 const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',b=>{buffer=Buffer.concat([buffer,b]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){const n=buffer.readUInt32LE(0);replies.push(JSON.parse(buffer.subarray(4,4+n)));buffer=buffer.subarray(4+n);}if(replies.length===2)resolve();});});
 child.stdin.write(data.subarray(0,2));child.stdin.write(data.subarray(2));await completed;
 assert.deepEqual(replies.map(x=>x.id).sort(),['native-001','native-002']);assert.ok(replies.every(x=>x.ok));
});
