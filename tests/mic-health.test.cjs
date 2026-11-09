// Live microphone cleanup health: a chain process that is alive but whose PipeWire
// graph is gone (or no longer reads the microphone) must not count as working.
// The chain runs a real child process (a stand-in for pipewire) and reads the graph
// through an injected PipeWire query, so no audio device is touched.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {AudioChain,ChainWatch,syncCleanup,SOURCE,TIMING}=require('../audio-chain.cjs');

const MIC='alsa_input.test-mic';
const SETTINGS={microphone:MIC,micNoise:'off',micRumble:true};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vc-mic-health-'));
const fakePipewire=path.join(dir,'pipewire');
fs.writeFileSync(fakePipewire,'#!/bin/sh\nexec sleep 60\n',{mode:0o755});

// The PipeWire graph as pactl would report it. The chain's nodes belong to client 900
// (PipeWire object id), whose process id is the chain's own child (or another process
// when owner is set). As with real pipewire-pulse, pactl's client index differs from the
// object id, and another client's index happens to equal 900.
function graph(){
  const g={source:false,input:false,inputFrom:MIC,fail:false,hang:false,owner:null,calls:0,timeouts:[],chain:null,
    gate(o){g.timeouts.push(o&&o.timeout);if(g.hang)return new Promise(()=>{});if(g.fail)throw new Error('pactl unavailable');},
    sources:async o=>{g.calls++;await g.gate(o);return [{index:41,name:MIC},{index:42,name:'alsa_input.other'},...(g.source?[{index:77,name:SOURCE,properties:{'client.id':'900'}}]:[])];},
    sourceOutputs:async o=>{await g.gate(o);return g.input?[{index:5,source:g.inputFrom===MIC?41:g.inputFrom===null?4294967295:42,properties:{'node.name':SOURCE+'.input','client.id':'900'}}]:[];},
    clients:async o=>{await g.gate(o);const pid=g.owner??String(g.chain?.child?.pid);return [{index:183385,properties:{'object.id':'900','pipewire.sec.pid':pid,'application.process.id':pid}},{index:900,properties:{'object.id':'32','pipewire.sec.pid':'1195'}}];},
    up(){g.source=true;g.input=true;g.inputFrom=MIC;},down(){g.source=false;g.input=false;}};
  return g;
}
// Short timings so failures resolve quickly; the defaults are checked separately.
const FAST={ensureMs:2000,startMs:300,verifyMs:100,queryMs:200,graceMs:200};
function chain(g,opts={}){const c=new AudioChain(dir,{pipewire:fakePipewire,query:g,pollMs:5,timing:FAST,...opts});g.chain=c;return c;}
const alive=c=>!!(c.child&&c.child.exitCode===null);
// Graph appears shortly after each start, like a real filter-chain.
function upAfterStart(c,g,delay=15){const orig=c.start.bind(c);let starts=0;c.start=async(...a)=>{starts++;setTimeout(()=>g.up(),delay);return orig(...a);};return ()=>starts;}

test('a healthy chain starts, reports running, and is reused without a restart',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());const starts=upAfterStart(c,g);
  assert.equal(await c.ensure(SETTINGS),SOURCE);
  assert.equal(c.running(),true);const pid=c.child.pid;
  assert.equal(await c.ensure(SETTINGS),SOURCE);
  assert.equal(c.child.pid,pid,'same process reused');assert.equal(starts(),1);
});

test('an alive process whose graph has no nodes is unhealthy and is restarted on the next ensure',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());const starts=upAfterStart(c,g);
  await c.ensure(SETTINGS);const pid=c.child.pid;
  g.down();// the microphone failed; PipeWire removed the nodes, the process lives on
  assert.ok(alive(c),'process still alive');
  assert.deepEqual(await c.health(),{ok:false,reason:'missing'});
  assert.equal(c.running(),false,'not reported as running, so the meter does not read a missing source');
  assert.equal(await c.ensure(SETTINGS),SOURCE);
  assert.notEqual(c.child.pid,pid,'restarted');assert.equal(starts(),2);assert.equal(c.running(),true);
});

test('a capture stream that is unlinked or reads another device is unhealthy',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);
  g.inputFrom=null;assert.deepEqual(await c.health(),{ok:false,reason:'unlinked'});
  g.inputFrom='alsa_input.other';assert.deepEqual(await c.health(),{ok:false,reason:'unlinked'});
  g.inputFrom=MIC;g.input=false;assert.deepEqual(await c.health(),{ok:false,reason:'no-input'});
});

test('a graph that never appears gives up after a bounded number of starts with a clear error',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());
  let spawns=0;const orig=c.start.bind(c);c.start=async(...a)=>{spawns++;return orig(...a);};
  const started=Date.now();
  await assert.rejects(c.ensure(SETTINGS),/Microphone cleanup did not start in time\./);
  assert.equal(spawns,2,'one retry, no loop');assert.ok(Date.now()-started<5000,'bounded time');
  assert.equal(alive(c),false,'no process left running');assert.equal(c.running(),false);
});

test('a source without a working microphone input reports a connection problem',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());
  const orig=c.start.bind(c);c.start=async(...a)=>{setTimeout(()=>{g.source=true;g.input=false;},5);return orig(...a);};
  await assert.rejects(c.ensure(SETTINGS),/could not connect to the microphone/);
});

test('an unknown graph never passes the recording preflight, and the chain is not killed for it',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);const pid=c.child.pid;
  // The graph disappears and PipeWire cannot be asked.
  g.down();g.fail=true;
  assert.equal((await c.health()).ok,null);
  await assert.rejects(c.ensure(SETTINGS),/Could not check the microphone cleanup\. Try again in a moment\./);
  assert.ok(alive(c)&&c.child.pid===pid,'kept, not restarted on an unknown answer');
  // The take's own preflight goes through the same method and refuses too.
  const started=Date.now();await assert.rejects(c.ensure(SETTINGS));assert.ok(Date.now()-started<2000,'bounded verification');
  // PipeWire answers again and the graph is gone: now it is restarted and verified.
  g.fail=false;
  assert.equal(await c.ensure(SETTINGS),SOURCE);assert.notEqual(c.child.pid,pid);assert.equal(c.running(),true);
});

test('an unknown answer that turns healthy within the bounded check reuses the chain',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);const pid=c.child.pid;
  g.fail=true;setTimeout(()=>{g.fail=false;},15);
  assert.equal(await c.ensure(SETTINGS),SOURCE);assert.equal(c.child.pid,pid);
});

test('sync shows an unverifiable chain as an error and clears it once verified',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);
  const recorder={state:{settings:SETTINGS,micCleanupError:null},set(d){Object.assign(this.state,d);}};
  g.fail=true;
  assert.match(await syncCleanup({chain:c,recorder,isBusy:()=>false}),/Could not check the microphone cleanup/);
  assert.match(recorder.state.micCleanupError,/Could not check/);
  g.fail=false;
  assert.equal(await syncCleanup({chain:c,recorder,isBusy:()=>false}),null);assert.equal(recorder.state.micCleanupError,null);
});

test('the watch recovers once, waits while the failure lasts, and does nothing during a take',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);
  let busy=false,recovers=0;
  const w=new ChainWatch({chain:c,isBusy:()=>busy,recover:async()=>{recovers++;}});
  assert.equal(await w.tick(),'healthy');
  busy=true;g.down();const before=g.calls;
  assert.equal(await w.tick(),'idle');assert.equal(g.calls,before,'no PipeWire queries during a take');assert.equal(recovers,0);
  busy=false;
  assert.equal(await w.tick(),'recovering');assert.equal(recovers,1);
  assert.equal(await w.tick(),'waiting');assert.equal(await w.tick(),'waiting');assert.equal(recovers,1,'no restart loop');
  g.up();assert.equal(await w.tick(),'healthy');
  g.down();assert.equal(await w.tick(),'recovering');assert.equal(recovers,2,'a new failure after recovery is handled again');
  w.start();w.start();assert.ok(w.timer);w.stop();assert.equal(w.timer,null);
});

test('sync records a lasting failure for the panel and clears it after a successful recovery',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());
  const states=[];const recorder={state:{settings:SETTINGS,micCleanupError:null},set(d){Object.assign(this.state,d);states.push({...d});}};
  let busy=false;const isBusy=()=>busy;
  // The microphone is broken: the graph never comes up.
  assert.match(await syncCleanup({chain:c,recorder,isBusy}),/did not start in time/);
  assert.match(recorder.state.micCleanupError,/did not start in time/);
  // During a take, sync does nothing at all.
  busy=true;assert.equal(await syncCleanup({chain:c,recorder,isBusy}),undefined);busy=false;
  // The microphone is back; Try again succeeds and clears the error.
  upAfterStart(c,g);
  assert.equal(await syncCleanup({chain:c,recorder,isBusy}),null);
  assert.equal(recorder.state.micCleanupError,null);assert.equal(c.running(),true);
  // No state change is published when nothing changed.
  const n=states.length;await syncCleanup({chain:c,recorder,isBusy});assert.equal(states.length,n);
});

test('turning cleanup off stops the chain and needs no graph',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);
  assert.equal(await c.ensure({...SETTINGS,micRumble:false}),null);
  assert.equal(alive(c),false);assert.equal(c.running(),false);
});

test('an unknown answer keeps a known error, keeps the chain, and is never handed out as working',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  await c.ensure(SETTINGS);const pid=c.child.pid;
  const recorder={state:{settings:SETTINGS,micCleanupError:'Known graph failure'},set(d){Object.assign(this.state,d);}};
  g.down();g.fail=true;
  await assert.rejects(c.ensure(SETTINGS),e=>e.unknown===true);
  assert.equal(await syncCleanup({chain:c,recorder,isBusy:()=>false}),'Known graph failure');
  assert.equal(recorder.state.micCleanupError,'Known graph failure','an unanswered check neither clears nor replaces a known error');
  assert.equal(c.child.pid,pid,'an idle chain is not restarted on a guess');
  assert.equal(c.running(),true,'last known health is kept for display while PipeWire is silent');
});

test('nodes with the right names that belong to another process do not count',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());
  g.up();g.owner='123';// someone else offers vidcapture_mic
  await assert.rejects(c.ensure(SETTINGS),/did not start in time/);
  assert.equal(alive(c),false,'the unverified chain is not left running');
  // Its own nodes are recognized once they appear.
  g.owner=null;
  assert.equal(await c.ensure(SETTINGS),SOURCE);
  assert.deepEqual(await c.health(),{ok:true});
  g.owner='123';
  assert.deepEqual(await c.health(),{ok:false,reason:'missing'});assert.equal(c.running(),false);
});

test('turning cleanup off while an ensure is waiting leaves no chain behind',async t=>{
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  let resume;c.resolveMic=()=>new Promise(r=>{resume=r;});
  const pending=c.ensure(SETTINGS);await new Promise(setImmediate);
  assert.equal(await c.ensure({...SETTINGS,micRumble:false}),null);
  resume(MIC);
  await assert.rejects(pending,e=>e.canceled===true);
  assert.equal(c.child,null,'no process spawned after the disable');assert.equal(c.running(),false);
  // The same through sync: the canceled ensure records nothing.
  const recorder={state:{settings:SETTINGS,micCleanupError:null},set(d){Object.assign(this.state,d);}};
  c.resolveMic=()=>new Promise(r=>{resume=r;});
  const sync=syncCleanup({chain:c,recorder,isBusy:()=>false});await new Promise(setImmediate);
  await c.stop();resume(MIC);
  assert.equal(await sync,undefined);assert.equal(recorder.state.micCleanupError,null);assert.equal(c.child,null);
});

// The canceled ensure can reject before stop() has finished waiting for the process to
// exit (under load, or a slow exit), so the expectation is attached before stopping.
// Awaiting stop() first left that rejection unhandled for a moment, which failed the
// test under parallel load (retained 195/196 run, extension task evidence).
async function stopWhileChecking(t,slowExitMs){
  const g=graph(),c=chain(g,{timing:{...FAST,startMs:2000}});t.after(()=>c.stop());
  if(slowExitMs){const kill=c.kill.bind(c);c.kill=async(...a)=>{await kill(...a);await new Promise(r=>setTimeout(r,slowExitMs));};}
  const pending=c.ensure(SETTINGS);
  const outcome=assert.rejects(pending,e=>e.canceled===true);
  while(!c.child)await new Promise(r=>setTimeout(r,2));
  const child=c.child;
  await c.stop();g.up();
  await outcome;
  assert.equal(c.child,null);assert.notEqual(child.exitCode===null&&child.signalCode===null,true,'spawned process ended');
}
test('stopping while a new chain is still being checked ends that chain',t=>stopWhileChecking(t,0));
test('the same holds when stopping waits a long time for the process to exit',t=>stopWhileChecking(t,100));

test('a stopped watch finishes a check in progress without recovering',async()=>{
  let finish,recovers=0;
  const w=new ChainWatch({chain:{child:{},health:()=>new Promise(r=>{finish=r;})},isBusy:()=>false,recover:async()=>{recovers++;}});
  w.start();const tick=w.tick();await new Promise(setImmediate);
  let drained=false;const stopped=w.stop().then(()=>{drained=true;});
  await new Promise(setImmediate);assert.equal(drained,false,'stop waits for the check in progress');
  finish({ok:false,reason:'missing'});await stopped;
  assert.equal(await tick,'stopped');assert.equal(recovers,0);assert.equal(w.timer,null);
  assert.equal(await w.tick(),'idle','nothing new starts after stop');
});

test('a hung PipeWire query is cut off at a wall-clock deadline',{timeout:10000},async t=>{
  const g=graph(),c=chain(g,{timing:{...FAST,ensureMs:600,startMs:400}});t.after(()=>c.stop());
  g.hang=true;
  let started=Date.now();
  await assert.rejects(c.ensure(SETTINGS),/did not start in time/);
  let took=Date.now()-started;assert.ok(took<600+400,`cold start settled in ${took} ms`);
  assert.equal(alive(c),false);
  // A running chain whose check hangs is refused within its own shorter bound.
  g.hang=false;upAfterStart(c,g);await c.ensure(SETTINGS);const pid=c.child.pid;
  g.hang=true;started=Date.now();
  await assert.rejects(c.ensure(SETTINGS),e=>e.unknown===true);
  took=Date.now()-started;assert.ok(took<FAST.verifyMs+300,`recheck settled in ${took} ms`);
  assert.equal(c.child.pid,pid,'kept');
  assert.ok(g.timeouts.every(ms=>ms>0&&ms<=FAST.queryMs),'each query gets a timeout no longer than queryMs');
});

test('the default timings bound an ensure to ten seconds',()=>{
  assert.equal(TIMING.ensureMs,10000);
  assert.ok(TIMING.startMs*2<=TIMING.ensureMs&&TIMING.queryMs<TIMING.startMs&&TIMING.verifyMs<TIMING.startMs);
});

test('quitting stops the microphone watch before the chain',()=>{
  const main=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8');
  const close=main.slice(main.indexOf('async function requestClose'),main.indexOf("app.on('before-quit'"));
  const watch=close.indexOf('micWatch?.stop()'),chainStop=close.indexOf('audioChain?.stop()'),firstWait=close.indexOf('await ',close.indexOf('closing=true;'));
  assert.ok(watch>0&&chainStop>watch,'watch stops first');
  assert.ok(watch<firstWait,'and before anything quitting waits on, such as the editor flush or a dialog');
  assert.match(close,/await watchDone/,'and is drained before quitting');
  assert.match(close,/finally\{[^}]*if\(!allowQuit\)\{[^}]*micWatch\?\.start\(\)/,'an abandoned close resumes the watch');
  assert.match(main,/async function syncMicChain\(\)\{[^}]*if\(closing\|\|/,'a late Try again or settings save starts no chain while quitting');
});

test('client ownership uses the PipeWire object id, not the pactl client index',async t=>{
  // Measured natively: the chain's nodes had client.id 93, and its pactl client entry had
  // index 183385 with object.id 93.
  const g=graph(),c=chain(g);t.after(()=>c.stop());upAfterStart(c,g);
  assert.equal(await c.ensure(SETTINGS),SOURCE);assert.deepEqual(await c.health(),{ok:true});
  // A foreign client whose pactl index equals the nodes' client.id does not make them ours.
  g.owner='123';
  assert.deepEqual(await c.health(),{ok:false,reason:'missing'});
});
