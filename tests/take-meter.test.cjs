// Microphone indicator on the recording controls (take-meter.cjs). The PipeWire graph
// and the level reader are fakes, so no device, stream, or audio is touched.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {TakeMeter,readGraph,peakScanner,peakLevel,isMonitor}=require('../take-meter.cjs');

const PID=4242,MIC='alsa_input.usb-mic',RAW_PROPS={'application.process.id':String(PID)};
const delay=ms=>new Promise(r=>setTimeout(r,ms));

// Sources as pactl lists them, and the recorder's own capture streams.
function sources(extra={}){
  return [
    {index:10,name:MIC,mute:false,volume:{mono:{value:65536}}},
    {index:11,name:'alsa_input.other',mute:false,volume:{mono:{value:65536}}},
    {index:12,name:'alsa_output.speakers.monitor',monitor_of_sink:'alsa_output.speakers',mute:false,volume:{'front-left':{value:65536}}},
    ...(extra.clean===false?[]:[{index:13,name:'vidcapture_mic',mute:false,volume:{mono:{value:65536}}}]),
  ];
}
const stream=(source,props=RAW_PROPS,more={})=>({index:500+source,source,mute:false,volume:{mono:{value:65536}},properties:{...props},...more});

test('the indicator follows the stream the recorder owns, not one with the same source',()=>{
  // Another app reads the same microphone; the recorder has no stream yet.
  const foreign=stream(10,{'application.process.id':'999'});
  assert.deepEqual(readGraph({sources:sources(),outputs:[foreign],clients:[],pid:PID,expect:MIC}),{state:'unlinked'});
  // Ownership through the client's PipeWire object id (pipewire-pulse streams).
  const viaClient=stream(10,{'client.id':'77'});
  const clients=[{index:183385,properties:{'object.id':'77','application.process.id':String(PID)}},{index:77,properties:{'object.id':'5','application.process.id':'999'}}];
  assert.deepEqual(readGraph({sources:sources(),outputs:[viaClient],clients,pid:PID,expect:MIC}),{state:'ok',source:MIC});
  // A client whose pactl index happens to be 77 does not make the stream ours.
  assert.deepEqual(readGraph({sources:sources(),outputs:[viaClient],clients:[clients[1]],pid:PID,expect:MIC}),{state:'unlinked'});
});

test('desktop audio is never read as the microphone',()=>{
  // System audio only: the recorder's only stream reads a monitor source.
  assert.equal(isMonitor(sources()[2]),true);
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(12)],clients:[],pid:PID,expect:null}),{state:'unlinked'});
  // Microphone and system audio: the microphone stream is picked, not the monitor.
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(12),stream(10)],clients:[],pid:PID,expect:null}),{state:'ok',source:MIC});
});

test('with cleanup on, the cleaned source is measured, not the raw backup',()=>{
  const outputs=[stream(10),stream(13)];// raw backup track and cleaned track
  assert.deepEqual(readGraph({sources:sources(),outputs,clients:[],pid:PID,expect:'vidcapture_mic'}),{state:'ok',source:'vidcapture_mic'});
  // The cleanup source is gone: reported as a cleanup failure, never the raw mic.
  assert.deepEqual(readGraph({sources:sources({clean:false}),outputs:[stream(10)],clients:[],pid:PID,expect:'vidcapture_mic'}),{state:'cleanup'});
});

test('a take on the default input follows the source the recorder actually reads',()=>{
  // The recorder's stream reads alsa_input.other even if the default is now something else.
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(11)],clients:[],pid:PID,expect:null}),{state:'ok',source:'alsa_input.other'});
  // A named microphone whose stream was moved elsewhere is not reported as working.
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(11)],clients:[],pid:PID,expect:MIC}),{state:'unlinked'});
});

test('muted only from metadata: source mute, stream mute, or zero source volume; zero stream volume is resolved',()=>{
  const s=sources();s[0].mute=true;
  assert.equal(readGraph({sources:s,outputs:[stream(10)],clients:[],pid:PID,expect:MIC}).state,'muted');
  assert.equal(readGraph({sources:sources(),outputs:[stream(10,RAW_PROPS,{mute:true})],clients:[],pid:PID,expect:MIC}).state,'muted');
  // A zero stream volume alone is not proof: it is resolved against the stream's own
  // PipeWire node first (take-meter-zero.test.cjs), so readGraph reports it as 'zero'.
  assert.equal(readGraph({sources:sources(),outputs:[stream(10,RAW_PROPS,{volume:{mono:{value:0}}})],clients:[],pid:PID,expect:MIC}).state,'zero');
  const z=sources();z[0].volume={'front-left':{value:0},'front-right':{value:0}};
  assert.equal(readGraph({sources:z,outputs:[stream(10)],clients:[],pid:PID,expect:MIC}).state,'muted');
  // One channel at zero is not muted.
  const half=sources();half[0].volume={'front-left':{value:0},'front-right':{value:30000}};
  assert.equal(readGraph({sources:half,outputs:[stream(10)],clients:[],pid:PID,expect:MIC}).state,'ok');
});

test('a sample split across chunks is joined, not dropped or misread',()=>{
  const whole=Buffer.alloc(6);whole.writeInt16LE(100,0);whole.writeInt16LE(-20000,2);whole.writeInt16LE(300,4);
  const a=peakScanner();a.scan(whole);
  const b=peakScanner();b.scan(whole.subarray(0,3));b.scan(whole.subarray(3,5));b.scan(whole.subarray(5));
  assert.equal(b.take(),a.take());assert.equal(b.take(),0,'take resets the peak');
  // A lone trailing byte is held, not read as a sample.
  const c=peakScanner();c.scan(Buffer.from([0x00,0x00,0xff]));assert.equal(c.take(),0);
  c.scan(Buffer.from([0x7f]));assert.equal(c.take(),32767,'0xff,0x7f joined is the largest sample');
  assert.equal(peakLevel(0),0);assert.ok(peakLevel(32767)>0.9999);assert.ok(Math.abs(peakLevel(32768*0.01)-(1/3))<0.01,'-40 dBFS is one third');
});

// Fake level reader: tests push samples into it.
function fakeSpawn(){
  const spawned=[];
  const fn=(cmd,args)=>{const c=new EventEmitter();c.cmd=cmd;c.args=args;c.stdout=new EventEmitter();c.killed=false;c.kill=()=>{c.killed=true;queueMicrotask(()=>c.emit('exit',0));};spawned.push(c);return c;};
  fn.spawned=spawned;fn.live=()=>spawned.filter(c=>!c.killed);
  return fn;
}
const pcm=(amplitude,n=160)=>{const b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(i%2?amplitude:-amplitude,i*2);return b;};
function fakeGraph(){
  const g={fail:false,hang:false,outputs:[stream(10)],srcs:sources(),calls:0,
    gate:async()=>{g.calls++;if(g.hang)return new Promise(()=>{});if(g.fail)throw new Error('pactl unavailable');},
    sources:async()=>{await g.gate();return g.srcs;},sourceOutputs:async()=>{await g.gate();return g.outputs;},clients:async()=>{await g.gate();return [];}};
  return g;
}
const FAST={statusMs:40,queryMs:30,tickMs:10,quietMs:60,staleMs:50};
function meter(g,spawn){const states=[];const m=new TakeMeter({onUpdate:x=>states.push(x),spawn,query:g,timing:FAST});m.states=states;m.lastState=()=>states.at(-1)?.state;return m;}
async function until(fn,ms=1000){const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await delay(5);}return false;}

test('signal shows as live with its level; fresh silence settles to quiet, never to an error',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.equal(m.lastState(),'checking','nothing is confirmed before the first check');
  assert.ok(await until(()=>sp.live().length===1));
  const reader=sp.live()[0];assert.equal(reader.cmd,'parec');assert.deepEqual(reader.args.slice(0,2),['--device',MIC]);
  const feed=setInterval(()=>reader.stdout.emit('data',pcm(16000)),5);t.after(()=>clearInterval(feed));
  assert.ok(await until(()=>m.lastState()==='live'));
  // 16000 is about -6.2 dBFS, which is 0.90 on the -60..0 dB scale.
  assert.ok(m.states.filter(s=>s.state==='live').every(s=>s.level>=0.89&&s.level<=0.91),'the level matches the signal');
  clearInterval(feed);
  const quiet=setInterval(()=>reader.stdout.emit('data',pcm(0)),5);t.after(()=>clearInterval(quiet));
  assert.ok(await until(()=>m.lastState()==='quiet'),'zeros that keep arriving are quiet');
  assert.equal(m.states.at(-1).level,0);
  assert.ok(!m.states.some(s=>['muted','unavailable','unlinked'].includes(s.state)),'silence never claims a fault');
});

test('a level tick between data chunks keeps the shown level instead of dropping to zero',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.live().length===1));
  const reader=sp.live()[0];
  // Chunks arrive more slowly than ticks (as parec's 50 ms chunks can against 100 ms ticks).
  const feed=setInterval(()=>reader.stdout.emit('data',pcm(16000)),25);t.after(()=>clearInterval(feed));
  assert.ok(await until(()=>m.lastState()==='live'));
  const from=m.states.length;await delay(200);
  assert.ok(m.states.slice(from).every(s=>s.state==='live'&&s.level>=0.89),'no zero flicker between chunks');
});

test('a reader that stops delivering data is unavailable, not quiet',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.live().length===1));
  sp.live()[0].stdout.emit('data',pcm(16000));
  assert.ok(await until(()=>m.lastState()==='live'));
  // No more data at all.
  assert.ok(await until(()=>m.lastState()==='unavailable'));
  // A reader that never delivered anything is not reported as working either.
  const m2=meter(fakeGraph(),fakeSpawn());t.after(()=>m2.stop());
  m2.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>m2.lastState()==='unavailable'));
  assert.ok(!m2.states.some(s=>s.state==='live'||s.state==='quiet'));
});

test('when PipeWire cannot be asked, the indicator says so and reads nothing',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  g.fail=true;
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>m.lastState()==='unavailable'));
  assert.equal(sp.spawned.length,0);
  // A hung query is cut off the same way.
  const h=fakeGraph();h.hang=true;const m2=meter(h,fakeSpawn());t.after(()=>m2.stop());
  m2.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>m2.lastState()==='unavailable'));
});

test('a stream that is lost or muted mid-take drops the level at once',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.live().length===1));
  const reader=sp.live()[0];const feed=setInterval(()=>reader.stdout.emit('data',pcm(16000)),5);t.after(()=>clearInterval(feed));
  assert.ok(await until(()=>m.lastState()==='live'));
  g.outputs=[stream(10,RAW_PROPS,{mute:true})];
  assert.ok(await until(()=>m.lastState()==='muted'));
  assert.equal(reader.killed,true,'the reader stops while muted');
  g.outputs=[];
  assert.ok(await until(()=>m.lastState()==='unlinked'));
  assert.equal(sp.live().length,0);
});

test('when the recorder stream moves to another source, the reader follows it',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:null});// default input
  assert.ok(await until(()=>sp.live().length===1));
  const first=sp.live()[0];
  g.outputs=[stream(11)];
  assert.ok(await until(()=>first.killed&&sp.live().length===1));
  assert.deepEqual(sp.live()[0].args.slice(0,2),['--device','alsa_input.other']);
});

test('paused stops the reader and shows paused; resume shows nothing stale',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.live().length===1));
  const reader=sp.live()[0];reader.stdout.emit('data',pcm(16000));
  assert.ok(await until(()=>m.lastState()==='live'));
  m.sync({pid:PID,phase:'paused',expect:MIC});
  assert.equal(m.lastState(),'paused');assert.equal(reader.killed,true);assert.equal(m.poll,null);assert.equal(m.tick,null);
  // A late chunk from the old reader changes nothing.
  reader.stdout.emit('data',pcm(30000));await delay(30);assert.equal(m.lastState(),'paused');
  const callsWhilePaused=g.calls;await delay(60);assert.equal(g.calls,callsWhilePaused,'no PipeWire checks while paused');
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.equal(m.lastState(),'checking','resume starts unconfirmed, not with the old peak');
  assert.ok(await until(()=>sp.live().length===1&&sp.live()[0]!==reader));
});

test('stopping ends every check, timer, and reader; late answers from an old take are dropped',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.live().length===1));
  // A check from this take is in flight when a restart begins a new take.
  let release;g.gate=async()=>{g.calls++;await new Promise(r=>{release=r;});};
  await delay(FAST.statusMs+10);
  m.sync({pid:PID+1,phase:'recording',expect:MIC});
  assert.equal(sp.live().length,0,'the old take reader is stopped');
  const n=m.states.length;release();await delay(5);
  assert.ok(m.states.slice(n).every(s=>s.state==='checking'),'the old answer did not revive the indicator');
  m.stop();
  assert.equal(m.poll,null);assert.equal(m.tick,null);assert.equal(m.reader,null);assert.equal(m.take,null);
  const after=m.states.length;await delay(80);assert.equal(m.states.length,after,'nothing is sent after stop');
  assert.equal(sp.live().length,0);
});

test('a take with no microphone shows none and starts nothing',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:null,micNone:true});
  assert.equal(m.lastState(),'none');await delay(60);
  assert.equal(sp.spawned.length,0);assert.equal(g.calls,0);
  // Stopping phases end the meter.
  m.sync({pid:PID,phase:'stopping'});assert.equal(m.take,null);
});

test('cleanup failure is shown when the cleaned source goes away mid-take',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  g.outputs=[stream(10),stream(13)];
  m.sync({pid:PID,phase:'recording',expect:'vidcapture_mic'});
  assert.ok(await until(()=>sp.live().length===1));
  assert.deepEqual(sp.live()[0].args.slice(0,2),['--device','vidcapture_mic'],'the cleaned track is measured');
  g.srcs=sources({clean:false});g.outputs=[stream(10)];
  assert.ok(await until(()=>m.lastState()==='cleanup'));
  assert.equal(sp.live().length,0,'it does not fall back to reading the raw microphone');
});

test('a corked recorder stream is held: no reader and no level, even if the source is loud',async t=>{
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(10,RAW_PROPS,{corked:true})],clients:[],pid:PID,expect:MIC}),{state:'held',source:MIC});
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  g.outputs=[stream(10,RAW_PROPS,{corked:true})];
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>m.lastState()==='held'));
  await delay(60);assert.equal(sp.spawned.length,0,'no separate reader for a stream that takes no audio');
  assert.ok(!m.states.some(s=>s.state==='live'||s.state==='quiet'));
  // Corked mid-take: the running reader is stopped and the level drops.
  g.outputs=[stream(10)];
  assert.ok(await until(()=>sp.live().length===1));
  const reader=sp.live()[0];const feed=setInterval(()=>reader.stdout.emit('data',pcm(16000)),5);t.after(()=>clearInterval(feed));
  assert.ok(await until(()=>m.lastState()==='live'));
  g.outputs=[stream(10,RAW_PROPS,{corked:true})];
  assert.ok(await until(()=>m.lastState()==='held'));assert.equal(reader.killed,true);
});

test('owned streams that disagree are not resolved by order',()=>{
  const muted=stream(10,RAW_PROPS,{mute:true,index:601}),open=stream(10,RAW_PROPS,{index:602});
  assert.deepEqual(readGraph({sources:sources(),outputs:[open,muted],clients:[],pid:PID,expect:MIC}),{state:'unavailable',reason:'ambiguous'});
  assert.deepEqual(readGraph({sources:sources(),outputs:[muted,open],clients:[],pid:PID,expect:MIC}),{state:'unavailable',reason:'ambiguous'});
  const corked=stream(10,RAW_PROPS,{corked:true,index:603});
  assert.equal(readGraph({sources:sources(),outputs:[open,corked],clients:[],pid:PID,expect:MIC}).state,'unavailable');
  // Two that agree are fine.
  assert.deepEqual(readGraph({sources:sources(),outputs:[open,stream(10,RAW_PROPS,{index:604})],clients:[],pid:PID,expect:MIC}),{state:'ok',source:MIC});
  // Following the default input, two microphone streams on different sources are ambiguous.
  assert.deepEqual(readGraph({sources:sources(),outputs:[stream(10),stream(11)],clients:[],pid:PID,expect:null}),{state:'unavailable',reason:'ambiguous'});
});

// A real child process that ignores SIGTERM and keeps writing PCM.
const {spawn:realSpawn}=require('node:child_process');
function stubbornSpawn(){
  const children=[];
  const fn=()=>{const c=realSpawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write(Buffer.alloc(320,0x40)),20)"],{stdio:['ignore','pipe','ignore']});children.push(c);return c;};
  fn.children=children;return fn;
}
const alivePid=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function stubbornCase(t,end){
  const g=fakeGraph(),sp=stubbornSpawn();
  const m=new TakeMeter({onUpdate:x=>states.push(x),spawn:sp,query:g,timing:{...FAST,graceMs:150}});const states=[];
  t.after(()=>{m.stop();for(const c of sp.children)try{c.kill('SIGKILL');}catch{}});
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>states.at(-1)?.state==='live',3000),'the stubborn reader delivers data');
  const child=sp.children[0];
  await end(m,g);
  const n=states.length;
  const started=Date.now();const drained=await m.drain();const took=Date.now()-started;
  assert.ok(took<150+250+200,`drained in ${took} ms`);
  assert.equal(alivePid(child.pid),false,'no orphaned reader');
  assert.equal(m.draining.size,0);
  assert.deepEqual(drained,{unconfirmed:[]},'its exit was seen');
  return {m,states,n,child};
}
test('stop ends a reader that ignores SIGTERM: updates stop at once, the process is killed',async t=>{
  const {states,n}=await stubbornCase(t,async m=>{m.stop();});
  await delay(60);assert.equal(states.length,n,'nothing is sent after stop');
});
test('pause ends a reader that ignores SIGTERM',async t=>{
  const {states}=await stubbornCase(t,async m=>{m.sync({pid:PID,phase:'paused',expect:MIC});});
  assert.equal(states.at(-1).state,'paused');
});
test('a route switch ends the old reader that ignores SIGTERM',async t=>{
  const {m}=await stubbornCase(t,async(m,g)=>{
    const first=m.reader.child;g.outputs=[stream(11)];
    m.take.expect=null;// following the default input
    await until(()=>m.reader&&m.reader.child!==first,3000);
  });
  m.stop();await m.drain();
});

test('a reader whose exit is never seen is reported unconfirmed, stays tracked, and nothing hangs',async t=>{
  // A process boundary that accepts signals but never reports an exit.
  const signals=[];let child;
  const spawn=()=>{child=new EventEmitter();child.pid=31337;child.exitCode=null;child.signalCode=null;child.stdout=new EventEmitter();child.kill=sig=>{signals.push(sig);return false;};return child;};
  const g=fakeGraph(),m=new TakeMeter({onUpdate(){},spawn,query:g,timing:{...FAST,graceMs:100}});t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>!!child));
  m.stop();
  const started=Date.now();const result=await m.drain();const took=Date.now()-started;
  assert.deepEqual(result,{unconfirmed:[31337]},'not claimed as exited');
  assert.ok(took>=100&&took<100+250+150,`bounded: ${took} ms`);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  assert.equal(m.draining.size,1,'still tracked after the bounded wait');
  // Asking again does not signal again or wait again for the same process.
  const again=Date.now();assert.deepEqual(await m.drain(),{unconfirmed:[31337]});assert.ok(Date.now()-again<50);
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);
  // Its exit arrives later: now it is gone from tracking.
  child.emit('exit',null,'SIGKILL');
  assert.equal(m.draining.size,0);assert.deepEqual(await m.drain(),{unconfirmed:[]});
});

test('route changes never pile up readers while an earlier one has not exited',async t=>{
  // Every reader accepts signals but reports no exit until the test says so.
  const children=[];let next=60000;
  const spawn=()=>{const c=new EventEmitter();c.pid=next++;c.exitCode=null;c.signalCode=null;c.stdout=new EventEmitter();c.kill=()=>false;children.push(c);return c;};
  const g=fakeGraph(),states=[];
  const m=new TakeMeter({onUpdate:x=>states.push(x),spawn,query:g,timing:{...FAST,graceMs:30}});t.after(()=>m.stop());
  g.outputs=[stream(10)];
  m.sync({pid:PID,phase:'recording',expect:null});
  assert.ok(await until(()=>children.length===1));
  const feed=setInterval(()=>children.at(-1).stdout.emit('data',pcm(16000)),5);t.after(()=>clearInterval(feed));
  assert.ok(await until(()=>states.at(-1)?.state==='live'));
  // The default source changes twice (1 -> 2 -> 3); the first reader never exits.
  g.outputs=[stream(11)];
  assert.ok(await until(()=>states.at(-1)?.state==='unavailable'),'no reader for the new route yet: unavailable');
  await delay(FAST.statusMs*3);
  g.srcs=[...sources(),{index:14,name:'alsa_input.third',mute:false,volume:{mono:{value:65536}}}];g.outputs=[stream(14)];
  await delay(FAST.statusMs*3);
  assert.equal(children.length,1,'no replacement while the first is unconfirmed');
  assert.equal(m.draining.size,1,'the first is still tracked');
  assert.equal(states.at(-1).state,'unavailable');
  // The first reader really exits: the reader for the current route starts at once.
  children[0].emit('exit',null,'SIGKILL');
  assert.ok(await until(()=>children.length===2),'replacement after the actual exit');
  assert.deepEqual(m.reader.source,'alsa_input.third');
  // Stopping now leaves at most the one current reader to report.
  m.stop();
  assert.deepEqual(await m.drain(),{unconfirmed:[children[1].pid]});
  assert.equal(children.length,2);
});
