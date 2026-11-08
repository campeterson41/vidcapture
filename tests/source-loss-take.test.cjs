// A whole take through Recorder.start with the recorder process, PipeWire answers and
// system commands replaced by stand-ins: the microphone route guard runs from the
// recorder itself (no controls window), for both recorder programs, and leaves
// system-only and no-microphone takes alone. No device, display or server is used.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const fsSync=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const {EventEmitter}=require('node:events');

const MIC='vc_ind_mic',RODE='alsa_input.usb-RODE';
const commands=[];
let nextPid=7000;
cp.execFile=function(cmd,args,opts,cb){
  if(typeof opts==='function'){cb=opts;opts={};}
  commands.push([cmd,...args]);
  const ok=stdout=>{setImmediate(()=>cb(null,{stdout,stderr:''}));};
  const fail=code=>{setImmediate(()=>cb(Object.assign(new Error(`${cmd} failed`),{code})));};
  if(cmd==='pgrep')return fail(1);
  if(cmd==='pactl'&&args.join(' ')==='-f json list sources')return ok(JSON.stringify([{name:MIC,description:'Fixture microphone'},{name:RODE,description:'RODE'},{name:'speakers.monitor',description:'Monitor'}]));
  if(cmd==='pactl'&&args[0]==='get-default-source')return ok(RODE+'\n');
  if(cmd==='hyprctl'&&args[0]==='clients')return ok('[]');
  if(cmd==='pactl'&&args[0]==='set-source-output-mute')throw new Error('the real mute command is never run here');
  if(cmd==='hyprctl'&&args[0]==='monitors')return ok(JSON.stringify([{name:'eDP-1',description:'Laptop',make:'',model:'',width:1280,height:720,scale:1,transform:0,x:0,y:0}]));
  return fail(1);
};
const spawned=[];
let current=null;// the graph of the take being started
let spawnHook=null;// adjusts the next recorder child (the recorder keeps the spawn it loaded with)
cp.spawn=function(cmd,args,opts){
  const c=new EventEmitter();c.cmd=cmd;c.args=args;c.env=opts?.env;c.pid=++nextPid;c.exitCode=null;c.signalCode=null;c.signals=[];
  c.stderr=new EventEmitter();
  c.kill=sig=>{c.signals.push(sig);setTimeout(()=>{c.exitCode=0;c.emit('exit',0,null);},5);return true;};
  const out=args[args.indexOf('-o')+1];
  spawnHook?.(c);
  setTimeout(()=>{fsSync.writeFileSync(out,'take');if(!c.silent)c.stderr.emit('data',Buffer.from('update fps: 30\n'));},10);
  if(current&&args.includes('-o')){current.pid=c.pid;current.args=args;current.muted=new Set();}
  spawned.push(c);return c;
};
const {Recorder}=require('../recorder.cjs');
const {DEFAULTS}=require('../recorder.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

const src=(index,name)=>({index,name,properties:{'device.class':'sound'}});
// A graph that follows the take: the recorder reads what its arguments say, the
// cleanup process (when there is one) reads the microphone and owns vidcapture_mic.
function fakeGraph(){
  const g={lost:false,pid:null,ask:0,args:[],chainPid:null,muted:new Set()};
  const answer=k=>{g.ask++;
    const sources=[...(g.lost?[]:[src(1,MIC)]),src(2,RODE),...(g.chainPid?[{...src(4,'vidcapture_mic'),properties:{'device.class':'sound','client.id':'60'}}]:[])];
    const index=n=>({[MIC]:g.lost?2:1,[RODE]:2,vidcapture_mic:4})[n];
    const devs=g.args.filter((x,i)=>g.args[i-1]==='-a').flatMap(a=>a.split('|')).filter(a=>a.startsWith('device:')).map(a=>a.slice(7));
    const outputs=g.pid?devs.map((d,i)=>({index:30+i,source:index(d),mute:g.muted.has(30+i),properties:{'application.process.id':String(g.pid),'node.name':`gsr-${d}`}})):[];
    if(g.chainPid)outputs.push({index:20,source:index(MIC),properties:{'application.process.id':String(g.chainPid),'node.name':'vidcapture_mic.input'}});
    const clients=g.chainPid?[{index:1,properties:{'object.id':'60','application.process.id':String(g.chainPid)}}]:[];
    return Promise.resolve(k==='s'?sources:k==='o'?outputs:clients);};
  g.mute=async i=>{g.muted.add(i);};
  g.query={sources:()=>answer('s'),sourceOutputs:()=>answer('o'),clients:()=>answer('c')};
  return g;
}

async function recorderFor(t,settings,target,extra={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-loss-'));
  const g=fakeGraph();
  const r=new Recorder({dataDir:path.join(root,'state'),outputDir:path.join(root,'videos'),guardQuery:g.query,guardTiming:{intervalMs:20,queryMs:200,unconfirmedMs:2000},faultStopMs:200,faultKillMs:100,muteStream:i=>g.mute(i),...extra});
  current=g;r.stopMs=2000;
  await fs.mkdir(r.dataDir,{recursive:true});await fs.mkdir(r.outputDir,{recursive:true});
  await r.refreshDevices();
  r.state.settings={...DEFAULTS,camera:'none',...settings};
  r.state.target=target;
  t.after(async()=>{r.stopSourceGuard();await r.dispose();await fs.rm(root,{recursive:true,force:true});});
  return {r,g,root};
}
const SCREEN={kind:'monitor',monitor:'eDP-1',label:'Laptop display',x:0,y:0,width:1280,height:720};

test('a screen take: pinned stream policy, guard from the recorder, and a lost microphone stops and saves it',async t=>{
  const {r,g}=await recorderFor(t,{microphone:MIC,systemAudio:false},SCREEN);
  await r.start();
  const child=spawned.at(-1);g.pid=child.pid;
  assert.equal(child.cmd,'gpu-screen-recorder');
  assert.equal(child.env.PULSE_PROP,'node.dont-fallback=true state.restore-props=false');
  assert.equal(child.args[child.args.indexOf('-a')+1],`device:${MIC}`);
  assert.ok(r.sourceGuard,'the guard runs with no controls window at all');
  assert.equal(r.sourceGuard.pid,child.pid,'bound to this take\'s recorder process');
  await delay(80);assert.equal(r.state.phase,'recording','a healthy route is left alone');
  const lostAt=Date.now();g.lost=true;
  for(let i=0;i<100&&r.state.phase!=='saved'&&r.state.phase!=='error';i++)await delay(10);
  assert.ok(Date.now()-lostAt<500,`stopped within ${Date.now()-lostAt} ms of the loss`);
  assert.deepEqual(child.signals,['SIGINT']);
  assert.match(r.state.error,/microphone was disconnected/);
  // The stand-in file cannot be validated (no ffprobe here): the reason stays, and no
  // saved recording is claimed.
  assert.doesNotMatch(r.state.error,/part recorded before that was saved/);assert.match(r.state.error,/kept as MKV/);
  const kept=r.state.recent.map(f=>path.basename(f.path));assert.equal(kept.length,1,'the take before the loss is kept');
  const side=JSON.parse(await fs.readFile(path.join(r.dataDir,kept[0]+'.json'),'utf8'));
  assert.equal(side.micStopped.reason,'lost');assert.equal(side.micStopped.source,MIC);
  assert.equal(r.sourceGuard,null);
  // The next take starts with a fresh guard and no leftover fault.
  g.lost=false;
  await r.start();const next=spawned.at(-1);g.pid=next.pid;
  assert.equal(r.micFaultInfo,null);assert.equal(r.sourceGuard.pid,next.pid);
  await delay(60);assert.equal(r.state.phase,'recording');
  await r.stop();assert.equal(r.state.phase,'saved');assert.equal(r.state.error?.includes('microphone')??false,false);
});

test('a window take uses the follow recorder with the same policy and guard',async t=>{
  const follow=path.join(os.tmpdir(),`vc-follow-${process.pid}`);await fs.writeFile(follow,'');t.after(()=>fs.rm(follow,{force:true}));
  const {r,g}=await recorderFor(t,{microphone:MIC},{kind:'window',available:true,label:'Editor',class:'code',address:'0x1',x:10,y:10,width:640,height:480},{followEngine:follow});
  r.updateWindow=async()=>{};
  await r.start();const child=spawned.at(-1);g.pid=child.pid;
  assert.equal(child.cmd,follow);
  assert.equal(child.env.PULSE_PROP,'node.dont-fallback=true state.restore-props=false');
  assert.equal(r.sourceGuard.pid,child.pid);
  g.lost=true;
  for(let i=0;i<100&&r.state.phase!=='saved'&&r.state.phase!=='error';i++)await delay(10);
  assert.match(r.state.error,/disconnected/);
});

test('Default is resolved once and recorded as that source',async t=>{
  const {r,g}=await recorderFor(t,{microphone:'default_input'},SCREEN);
  await r.start();const child=spawned.at(-1);g.pid=child.pid;
  assert.equal(child.args[child.args.indexOf('-a')+1],`device:${RODE}`);
  assert.equal(r.sourceGuard.plan.mic,RODE);assert.equal(r.takeAudio.micSource,RODE);
  await r.stop();
});

test('cleanup on: the cleaned and raw backup tracks are pinned and the cleanup process is bound',async t=>{
  const chain={mic:MIC,child:{pid:9999},ensure:async()=>'vidcapture_mic',stop:async()=>{}};
  const {r,g}=await recorderFor(t,{microphone:MIC,micNoise:'on',micBackup:true},SCREEN,{audioChain:chain});
  g.chainPid=9999;
  await r.start();const child=spawned.at(-1);g.pid=child.pid;
  const a=child.args.filter((x,i)=>child.args[i-1]==='-a');
  assert.deepEqual(a,['device:vidcapture_mic',`device:${MIC}`]);
  assert.equal(child.env.PULSE_PROP,'node.dont-fallback=true state.restore-props=false');
  assert.deepEqual(r.sourceGuard.plan.chain,{pid:9999,expect:[MIC],allowed:[MIC],output:'vidcapture_mic'});
  r.stopSourceGuard();await r.stop();
  // Cleanup that resolved a different microphone than the take fails the start.
  const odd={...chain,mic:RODE};
  const b=await recorderFor(t,{microphone:'default_input',micNoise:'on'},SCREEN,{audioChain:{...odd,mic:'other_mic'}});
  await assert.rejects(b.r.start(),/default microphone changed/);
});

test('system-only and no-microphone takes keep their old behavior',async t=>{
  for(const s of [{microphone:'none',systemAudio:true},{microphone:'none',systemAudio:false}]){
    const {r}=await recorderFor(t,s,SCREEN);
    await r.start();const child=spawned.at(-1);
    assert.equal(child.env.PULSE_PROP,process.env.PULSE_PROP,'no stream policy added');
    assert.equal(r.sourceGuard,null,'no guard');
    if(s.systemAudio)assert.equal(child.args[child.args.indexOf('-a')+1],'default_output');
    else assert.ok(!child.args.includes('-a'));
    await r.stop();assert.equal(r.state.phase,'saved');
  }
});

test('the microphone going away while the take starts fails the start',async t=>{
  const {r,g}=await recorderFor(t,{microphone:MIC},SCREEN);
  g.lost=true;
  // Hold the recorder's first output back so the guard answers first.
  spawnHook=c=>{c.silent=true;};
  try{await assert.rejects(r.start(),/disconnected/);}finally{spawnHook=null;}
  assert.notEqual(r.state.phase,'recording');assert.equal(r.sourceGuard,null);
  await assert.rejects(fs.access(path.join(r.dataDir,'active.json')),'no active-take record is left behind');
  assert.ok(spawned.at(-1).signals.includes('SIGINT'),'the recorder that had started is stopped');
});

test('the microphone going away during the last startup step does not go live',async t=>{
  const {r,g}=await recorderFor(t,{microphone:MIC},SCREEN);
  const fsp=require('node:fs/promises');const write=fsp.writeFile;
  fsp.writeFile=async(file,...rest)=>{
    if(String(file).endsWith('active.json')){g.lost=true;await r.sourceGuard?.tick();}
    return write(file,...rest);
  };
  t.after(()=>{fsp.writeFile=write;});
  await assert.rejects(r.start(),/disconnected/);
  fsp.writeFile=write;
  const child=spawned.at(-1);
  assert.notEqual(r.state.phase,'recording');assert.ok(child.signals.includes('SIGINT'));
  await delay(50);
  await assert.rejects(fs.access(path.join(r.dataDir,'active.json')),'the active-take record is not left behind');
});

test('a starting recorder that ignores the stop is killed within the bound, and one that survives stays accounted for',async t=>{
  for(const ignoreKill of [false,true]){
    const {r,g}=await recorderFor(t,{microphone:MIC},SCREEN,{faultStopMs:150,faultUnsafeMs:60,faultKillMs:60});
    g.lost=true;
    spawnHook=c=>{c.silent=true;c.kill=sig=>{c.signals.push(sig);if(sig==='SIGKILL'&&!ignoreKill)setTimeout(()=>{c.signalCode='SIGKILL';c.emit('exit',null,'SIGKILL');},5);return true;};};
    const begun=Date.now();
    try{await assert.rejects(r.start(),/disconnected/);}finally{spawnHook=null;}
    const took=Date.now()-begun;const child=spawned.at(-1);
    assert.ok(took<600,`ended in ${took} ms, not after the 5 s startup wait`);
    assert.deepEqual(child.signals,['SIGINT','SIGKILL']);
    if(ignoreKill){
      assert.equal(r.state.phase,'error');assert.match(r.state.error,new RegExp(`process ${child.pid}`));
      assert.doesNotMatch(r.state.error,/was saved/);
      assert.equal(r.child,child,'the live process is still owned');assert.ok(r.rawFile,'its file is still tracked');
      r.child=null;
    }else assert.notEqual(r.state.phase,'recording');
  }
});

test('a recorder whose exit is unconfirmed blocks new takes and settings, by ownership, not by name',async t=>{
  const {r,g}=await recorderFor(t,{microphone:MIC},SCREEN,{faultStopMs:50,faultUnsafeMs:30,faultKillMs:30});
  g.lost=true;
  spawnHook=c=>{c.silent=true;c.kill=sig=>{c.signals.push(sig);return true;};};
  try{await assert.rejects(r.start(),/has not exited/);}finally{spawnHook=null;}
  const old=r.child;assert.ok(old&&old.exitCode===null);
  // pgrep (stubbed) finds nothing: the block must come from the owned child itself.
  await assert.rejects(r.saveSettings({fps:60}),/has not exited yet/);
  g.lost=false;
  await assert.rejects(r.start(),/has not exited yet/);
  assert.equal(spawned.at(-1),old,'no new recorder was started');
  // When it finally exits, its file is saved under the same reason and the app is free.
  old.exitCode=0;old.emit('exit',0,null);
  for(let i=0;i<50&&r.child;i++)await delay(10);
  assert.equal(r.child,null);assert.match(r.state.error||'',/disconnected/);
  await r.start();assert.equal(r.state.phase,'recording');assert.notEqual(r.child,old);
  r.stopSourceGuard();await r.stop();
});

test('a late exit of an earlier recorder never ends a newer take',async t=>{
  const {r,g}=await recorderFor(t,{microphone:MIC},SCREEN);
  await r.start();const first=r.child;
  // The newer take, as far as the recorder state is concerned.
  const next=new EventEmitter();next.pid=99001;next.exitCode=null;next.signalCode=null;next.kill=()=>true;
  r.stopSourceGuard();r.child=next;
  first.emit('exit',0,null);await delay(30);
  assert.equal(r.state.phase,'recording','the newer take is still recording');assert.equal(r.child,next);
  r.child=first;first.exitCode=0;r.state.phase='idle';
});
