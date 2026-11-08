// The microphone route guard: pure route checks against PipeWire answers, its timing
// bounds, and how the recorder ends a take on a fault. No audio device, PipeWire
// server or recorder process is used; the graph and the child are stand-ins.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {SourceGuard,evaluate,takePlan,faultMessage,pinEnv}=require('../source-guard.cjs');
const {Recorder,buildArgs,DEFAULTS}=require('../recorder.cjs');

const PID=4100,CHAIN=4200;
const src=(index,name,extra={})=>({index,name,mute:false,properties:{'device.class':'sound',...extra}});
const mon=(index,name)=>({index,name:`${name}.monitor`,monitor_of_sink:'7',properties:{'device.class':'monitor'}});
const out=(index,source,pid,name,extra={})=>({index,source,corked:false,mute:false,...extra,properties:{'application.process.id':String(pid),'node.name':name}});
const S={mic:'vc_ind_mic',rode:'alsa_input.usb-RODE',clean:'vidcapture_mic'};
const micOnly=takePlan({settings:{...DEFAULTS,microphone:S.mic,systemAudio:false},mic:S.mic});
const graph=(sources,outputs,clients=[])=>({sources,outputs,clients});

test('the take plan covers every microphone path, and nothing without one',()=>{
  assert.equal(takePlan({settings:{...DEFAULTS,microphone:'none',systemAudio:true},mic:null}),null,'system-only takes are not guarded');
  assert.equal(takePlan({settings:{...DEFAULTS,microphone:'none'},mic:null}),null);
  assert.deepEqual(micOnly.recorder.expect,[S.mic]);assert.equal(micOnly.chain,null);
  const both=takePlan({settings:{...DEFAULTS,microphone:S.mic,micBackup:true},mic:S.mic,clean:S.clean,chainPid:CHAIN});
  assert.deepEqual(both.sources.sort(),[S.clean,S.mic].sort(),'the cleaned source and the raw microphone must both exist');
  assert.deepEqual(both.recorder.expect,[S.clean,S.mic],'the raw backup is protected as well as the cleaned track');
  assert.deepEqual(both.chain,{pid:CHAIN,expect:[S.mic],allowed:[S.mic],output:S.clean},'the cleanup input is protected');
  const noBackup=takePlan({settings:{...DEFAULTS,microphone:S.mic,micBackup:false},mic:S.mic,clean:S.clean,chainPid:CHAIN});
  assert.deepEqual(noBackup.recorder.allowed,[S.clean],'without the backup, the recorder may read only the cleaned source');
});

test('test D: the same recorder on another source under the old stream name is a fault, not the chosen microphone',()=>{
  const before=graph([src(1,S.mic),src(2,S.rode)],[out(210978,1,PID,'gsr-vc_ind_mic')]);
  assert.deepEqual(evaluate({plan:micOnly,pid:PID,...before}),{ok:true});
  // The source is unloaded: lost at once.
  const lost=evaluate({plan:micOnly,pid:PID,...graph([src(2,S.rode)],[])});
  assert.equal(lost.fault,'lost');assert.equal(lost.source,S.mic);
  // A new stream of the same process on the physical default, still named after the old
  // source. Even with a source of that name back again, the actual route decides.
  const moved=evaluate({plan:micOnly,pid:PID,...graph([src(3,S.mic),src(2,S.rode)],[out(211054,2,PID,'gsr-vc_ind_mic')])});
  assert.equal(moved.fault,'moved');assert.equal(moved.to,S.rode);assert.equal(moved.stream,211054);assert.equal(moved.who,'recorder');
});

test('ownership through the client list counts, other applications do not',()=>{
  const viaClient={index:9,source:2,properties:{'client.id':'77','node.name':'anything'}};
  const clients=[{index:3,properties:{'object.id':'77','pipewire.sec.pid':String(PID)}}];
  const r=evaluate({plan:micOnly,pid:PID,sources:[src(1,S.mic),src(2,S.rode)],outputs:[out(8,1,PID,'gsr-vc_ind_mic'),viaClient],clients});
  assert.equal(r.fault,'moved','a stream owned through its client is checked too');
  // Someone else's stream on another microphone is none of the take's business.
  const other=evaluate({plan:micOnly,pid:PID,...graph([src(1,S.mic),src(2,S.rode)],[out(8,1,PID,'gsr-vc_ind_mic'),out(9,2,9999,'gsr-vc_ind_mic')])});
  assert.deepEqual(other,{ok:true});
});

test('quiet, muted, corked and paused routes are fine; system audio monitors only with system audio on',()=>{
  const g=graph([{...src(1,S.mic),mute:true},mon(5,'speakers')],[out(8,1,PID,'gsr-vc_ind_mic',{corked:true,mute:true})]);
  assert.deepEqual(evaluate({plan:micOnly,pid:PID,...g}),{ok:true});
  const withSystem=takePlan({settings:{...DEFAULTS,microphone:S.mic,systemAudio:true},mic:S.mic});
  const sys=graph([src(1,S.mic),mon(5,'speakers')],[out(8,1,PID,'gsr-vc_ind_mic'),out(9,1,PID,'gsr-vc_ind_mic'),out(10,5,PID,'gsr-default_output')]);
  assert.deepEqual(evaluate({plan:withSystem,pid:PID,...sys}),{ok:true});
  assert.equal(evaluate({plan:micOnly,pid:PID,...sys}).fault,'moved','with system audio off, a monitor is not the microphone');
});

test('unconfirmed routes: missing stream, unrouted stream',()=>{
  assert.deepEqual(evaluate({plan:micOnly,pid:PID,...graph([src(1,S.mic)],[])}),{ok:null,reason:'recorder-no-stream'});
  assert.deepEqual(evaluate({plan:micOnly,pid:PID,...graph([src(1,S.mic)],[out(8,44,PID,'gsr-vc_ind_mic')])}),{ok:null,reason:'recorder-stream-unrouted'});
});

test('cleanup on: upstream loss, raw backup moving, cleanup input moving, and cleaned output loss are all caught',()=>{
  const settings={...DEFAULTS,microphone:S.mic,micNoise:'on'};
  const plan=b=>takePlan({settings:{...settings,micBackup:b},mic:S.mic,clean:S.clean,chainPid:CHAIN});
  const chainClients=[{index:1,properties:{'object.id':'60','application.process.id':String(CHAIN)}}];
  const cleanSrc=src(4,S.clean,{'client.id':'60'});
  cleanSrc.properties['client.id']='60';
  const healthy=b=>graph([src(1,S.mic),src(2,S.rode),cleanSrc],[out(20,1,CHAIN,'vidcapture_mic.input'),out(21,4,PID,'gsr-vidcapture_mic'),...(b?[out(22,1,PID,'gsr-vc_ind_mic')]:[])],chainClients);
  for(const b of [false,true]){
    assert.deepEqual(evaluate({plan:plan(b),pid:PID,...healthy(b)}),{ok:true},`healthy, backup ${b}`);
    // The microphone is unloaded but the cleaned output survives: still lost.
    const up=healthy(b);up.sources=up.sources.filter(s=>s.name!==S.mic);
    const r=evaluate({plan:plan(b),pid:PID,...up});assert.equal(r.fault,'lost');assert.equal(r.source,S.mic);assert.equal(r.cleanup,false);
    // The cleanup input moves to the physical default while the cleaned output looks fine.
    const cin=healthy(b);cin.outputs[0]=out(20,2,CHAIN,'vidcapture_mic.input');
    const c=evaluate({plan:plan(b),pid:PID,...cin});assert.equal(c.fault,'moved');assert.equal(c.who,'cleanup');assert.equal(c.to,S.rode);
    // The cleaned output disappears.
    const gone=healthy(b);gone.sources=gone.sources.filter(s=>s.name!==S.clean);
    const g=evaluate({plan:plan(b),pid:PID,...gone});assert.equal(g.fault,'lost');assert.equal(g.cleanup,true);
    // The cleaned source exists but belongs to another process.
    const foreign=healthy(b);foreign.sources=foreign.sources.map(s=>s.name===S.clean?src(4,S.clean):s);
    assert.deepEqual(evaluate({plan:plan(b),pid:PID,...foreign}),{ok:null,reason:'cleanup-not-owned'});
  }
  // The raw backup moves while the cleaned track stays healthy.
  const bk=healthy(true);bk.outputs[2]=out(22,2,PID,'gsr-vc_ind_mic');
  const m=evaluate({plan:plan(true),pid:PID,...bk});assert.equal(m.fault,'moved');assert.equal(m.who,'recorder');assert.equal(m.stream,22);
  // Without the backup, a recorder stream on the raw microphone is not allowed either.
  const extra=healthy(false);extra.outputs.push(out(23,1,PID,'gsr-x'));
  assert.equal(evaluate({plan:plan(false),pid:PID,...extra}).fault,'moved');
});

test('fault messages explain the stop and that the earlier part is kept, without em dashes',()=>{
  for(const f of [{fault:'lost'},{fault:'lost',cleanup:true},{fault:'moved'},{fault:'unknown'}]){
    const m=faultMessage(f);assert.match(m,/stopped/);assert.match(m,/recorded before that was saved/);assert.ok(!/—/.test(m));
  }
});

test('the stream policy is added for the recorder process and keeps other properties',()=>{
  assert.equal(pinEnv({}).PULSE_PROP,'node.dont-fallback=true state.restore-props=false');
  assert.equal(pinEnv({PULSE_PROP:'media.role=video node.dont-fallback=false'}).PULSE_PROP,'media.role=video node.dont-fallback=true state.restore-props=false');
  const env={PATH:'/usr/bin'};pinEnv(env);assert.equal(env.PULSE_PROP,undefined,'the app environment itself is not changed');
});

test('Default is recorded as the one source it resolved to',()=>{
  const a=buildArgs({kind:'monitor',monitor:'eDP-1'},{...DEFAULTS,microphone:'default_input'},'/tmp/t.mkv',null,S.rode);
  assert.equal(a[a.indexOf('-a')+1],`device:${S.rode}`);
  const b=buildArgs({kind:'monitor',monitor:'eDP-1'},{...DEFAULTS,microphone:'default_input',micBackup:true},'/tmp/t.mkv',S.clean,S.rode);
  assert.deepEqual(b.filter((x,i)=>b[i-1]==='-a'),[`device:${S.clean}`,`device:${S.rode}`],'the backup reads the resolved source too');
});

// Guard timing. Stand-in queries; real timers with short intervals.
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function query(fn){const q={calls:[],active:0,maxActive:0};const wrap=k=>async o=>{q.calls.push({k,at:Date.now(),timeout:o.timeout});return fn(k,o);};q.sources=wrap('sources');q.sourceOutputs=wrap('outputs');q.clients=wrap('clients');return q;}
const okGraph={sources:[src(1,S.mic)],outputs:[out(8,1,PID,'gsr-vc_ind_mic')],clients:[]};
const answer=g=>k=>Promise.resolve(k==='sources'?g.sources:k==='outputs'?g.outputs:g.clients);

test('a loss is acted on within one poll, and only once',async t=>{
  let g=okGraph;const faults=[];
  const guard=new SourceGuard({plan:micOnly,pid:PID,query:query(k=>answer(g)(k)),timing:{intervalMs:20,queryMs:200,unconfirmedMs:1000},onFault:f=>faults.push(f)});
  t.after(()=>guard.stop());
  guard.start();await delay(60);assert.deepEqual(faults,[]);
  const lostAt=Date.now();g={sources:[src(2,S.rode)],outputs:[],clients:[]};
  await delay(80);
  assert.equal(faults.length,1);assert.equal(faults[0].fault,'lost');
  assert.ok(faults[0].at-lostAt<=60,`detected in ${faults[0].at-lostAt} ms`);
  await delay(60);assert.equal(faults.length,1,'one fault per take');assert.equal(guard.timer,null);
});

test('PipeWire not answering ends the take after the deadline, with bounded, non-overlapping queries',async t=>{
  const q=query(()=>new Promise(()=>{}));// never answers
  const faults=[];const start=Date.now();
  const guard=new SourceGuard({plan:micOnly,pid:PID,query:q,timing:{intervalMs:10,queryMs:50,unconfirmedMs:150},onFault:f=>faults.push(f)});
  t.after(()=>guard.stop());
  guard.start();
  await delay(120);assert.deepEqual(faults,[],'not before the deadline');
  await delay(150);
  assert.equal(faults.length,1);assert.equal(faults[0].fault,'unknown');assert.equal(faults[0].reason,'no-answer');
  const took=faults[0].at-start;assert.ok(took>=150&&took<=150+50+10+40,`ended after ${took} ms`);
  assert.ok(q.calls.every(c=>c.timeout===50),'every query carries its own timeout');
  assert.equal(q.calls.length,3,'a call that never answered is never piled on: one round only');
});

test('rejected and ambiguous answers are unconfirmed, not healthy',async t=>{
  for(const fn of [()=>Promise.reject(new Error('pactl failed')),answer({sources:[src(1,S.mic)],outputs:[],clients:[]})]){
    const faults=[];
    const guard=new SourceGuard({plan:micOnly,pid:PID,query:query(fn),timing:{intervalMs:10,queryMs:50,unconfirmedMs:100},onFault:f=>faults.push(f)});
    t.after(()=>guard.stop());
    guard.start();await delay(200);
    assert.equal(faults.length,1);assert.equal(faults[0].fault,'unknown');
  }
});

test('a slow healthy answer cannot stretch the deadline past when it was asked',async t=>{
  let n=0;const faults=[];
  const q=query(k=>{if(k==='sources')n++;return n===1?delay(300).then(()=>answer(okGraph)(k)):Promise.reject(new Error('down'));});
  const guard=new SourceGuard({plan:micOnly,pid:PID,query:q,timing:{intervalMs:10,queryMs:400,unconfirmedMs:150},onFault:f=>faults.push(f)});
  t.after(()=>guard.stop());
  guard.start();const start=guard.startedAt;
  await delay(500);
  assert.equal(faults.length,1);
  assert.ok(faults[0].at-start<420,`counted from the question, not the late answer (${faults[0].at-start} ms)`);
});

test('an answer that arrives after the guard stopped changes nothing',async t=>{
  let release;const faults=[];
  const q=query(()=>new Promise(r=>{release=r;}).then(()=>[]));
  const guard=new SourceGuard({plan:micOnly,pid:PID,query:q,timing:{intervalMs:10,queryMs:500,unconfirmedMs:0},onFault:f=>faults.push(f)});
  guard.start();await delay(20);guard.stop();release();await delay(30);
  assert.deepEqual(faults,[]);
});

// The recorder side: how a fault ends a take. The PipeWire graph is a stand-in whose
// streams honor (or, for the test, ignore) the supported mute operation.
function stubGraph(){
  const g={sources:[src(1,S.mic),src(2,S.rode),mon(5,'speakers')],outputs:[out(30,1,PID,'gsr-vc_ind_mic'),out(31,5,PID,'gsr-default_output')],clients:[],
    mutes:[],refuse:false,down:false,reopen:null};
  const ans=k=>g.down?Promise.reject(new Error('pactl failed')):Promise.resolve(structuredClone(k==='s'?g.sources:k==='o'?g.outputs:g.clients));
  g.query={sources:()=>ans('s'),sourceOutputs:()=>ans('o'),clients:()=>ans('c')};
  g.mute=async i=>{g.mutes.push(i);if(g.refuse)throw new Error('refused');const o=g.outputs.find(x=>x.index===i);if(o)o.mute=true;};
  return g;
}
async function liveRecorder(t,over={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-guard-'));
  const videos=path.join(root,'videos');
  const g=stubGraph();const events=[];
  const r=new Recorder({dataDir:path.join(root,'state'),outputDir:videos,faultStopMs:400,faultUnsafeMs:60,faultKillMs:60,
    guardQuery:g.query,guardTiming:{intervalMs:15,queryMs:50},muteStream:async i=>{events.push(['mute',i]);return g.mute(i);},...over});
  await fs.mkdir(r.dataDir,{recursive:true});await fs.mkdir(videos,{recursive:true});
  r.rawFile=path.join(videos,'Capture-2026-11-07T10-00-00-000Z.mkv');await fs.writeFile(r.rawFile,'partial take');
  const child=new EventEmitter();child.pid=PID;child.signals=[];child.ignore=new Set();child.exitDelay=5;
  child.kill=sig=>{child.signals.push(sig);events.push(['signal',sig]);if(!child.ignore.has(sig))setTimeout(()=>{g.outputs=[];child.emit('exit',sig==='SIGKILL'?null:0,sig==='SIGKILL'?'SIGKILL':null);},child.exitDelay);return true;};
  r.child=child;r.exitPromise=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const finishes=[];r.finish=async w=>{finishes.push(w);events.push(['finish']);r.child=null;return r.set({phase:'saved',error:w});};
  r.exitPromise.then(()=>{if(['recording','paused'].includes(r.state.phase))r.finish(null);});
  r.started=Date.now()-5000;r.state.phase='recording';
  const guard={stopped:0,stop(){this.stopped++;}};r.sourceGuard=guard;
  t.after(async()=>{await r.dispose();await fs.rm(root,{recursive:true,force:true});});
  return {r,g,child,guard,finishes,events};
}
const LOST={fault:'lost',source:S.mic,at:Date.now()};

test('a lost microphone stops and saves the take once, with the reason kept',async t=>{
  for(const phase of ['recording','paused']){
    const {r,child,guard,finishes}=await liveRecorder(t);
    r.state.phase=phase;
    const ending=r.micFault({...LOST,at:Date.now()},child,guard);
    assert.equal(r.state.phase,'stopping');
    assert.equal(await r.stop(),await ending,'Stop during the fault joins it');
    await assert.rejects(r.discard(),/no recording to discard/,'the take is being saved, not deleted');
    assert.deepEqual(child.signals,['SIGINT']);
    assert.equal(finishes.length,1);assert.match(finishes[0],/microphone was disconnected/);
    assert.doesNotMatch(finishes[0],/may include another microphone/,'no warning about the ending when the mute was confirmed');
    assert.equal(r.state.phase,'saved');assert.match(r.state.error,/recorded before that was saved/);
    assert.equal(r.micFaultInfo.reason,'lost');assert.equal(r.micFaultInfo.source,S.mic);assert.equal(r.micFaultInfo.cut,'muted');
    assert.equal(r.micFault(LOST,child,guard),null,'a second report changes nothing');
  }
});

test('the recorder is told to stop and its microphone muted at once, confirmed; system audio is left alone',async t=>{
  const {r,g,child,guard,events}=await liveRecorder(t);
  g.outputs[0]=out(211054,2,PID,'gsr-vc_ind_mic');// test D: reopened on the physical default
  const at=Date.now();const stamps=[];const mute=r.muteStream;r.muteStream=async i=>{stamps.push(Date.now()-at);return mute(i);};
  await r.micFault({fault:'moved',who:'recorder',stream:211054,to:S.rode,at},child,guard);
  assert.deepEqual(events.slice(0,2).map(e=>e.join(' ')).sort(),['mute 211054','signal SIGINT']);
  assert.ok(stamps[0]<30,`muted ${stamps[0]} ms after the fault`);
  assert.ok(!events.some(e=>e[0]==='mute'&&e[1]===31),'the system audio stream is not muted');
  assert.ok(r.micFaultInfo.unconfirmedMs<200,`unconfirmed for ${r.micFaultInfo.unconfirmedMs} ms`);assert.equal(r.micFaultInfo.uncertain,false);
});

test('a stream the recorder reopens while saving is muted too',async t=>{
  const {r,g,child,guard,events}=await liveRecorder(t);
  child.exitDelay=120;
  setTimeout(()=>{g.outputs.push(out(40,2,PID,'gsr-vc_ind_mic'));},40);
  await r.micFault({...LOST,at:Date.now()},child,guard);
  assert.ok(events.some(e=>e[0]==='mute'&&e[1]===40),'the reopened stream was muted');
  assert.deepEqual(child.signals,['SIGINT']);assert.equal(r.micFaultInfo.cut,'muted');
});

test('a mute that cannot be confirmed is not treated as safe: short bound, kill, and an honest note',async t=>{
  for(const how of ['refuse','down']){
    const {r,g,child,guard,finishes}=await liveRecorder(t);
    g[how]=true;child.ignore.add('SIGINT');
    const start=Date.now();
    await r.micFault({...LOST,at:Date.now()},child,guard);
    const took=Date.now()-start;
    assert.deepEqual(child.signals,['SIGINT','SIGKILL'],how);
    assert.ok(took<300,`${how}: killed after ${took} ms, not the 400 ms allowed for a muted take`);
    assert.equal(r.micFaultInfo.cut,'unconfirmed');assert.equal(r.micFaultInfo.killed,true);
    assert.match(finishes[0],/end of the recording may include another microphone/);
  }
});

test('a muted take that ignores the stop gets the full save window and is then killed',async t=>{
  const {r,child,guard,finishes}=await liveRecorder(t);child.ignore.add('SIGINT');
  r.faultUnsafeMs=1000;// a confirmed mute uses the save window, never the longer of the two
  const start=Date.now();
  await r.micFault({...LOST,at:Date.now()},child,guard);
  const took=Date.now()-start;
  assert.ok(took>=380&&took<700,`it had the 400 ms save window (${took} ms)`);
  assert.deepEqual(child.signals,['SIGINT','SIGKILL']);assert.equal(finishes.length,1);assert.equal(r.state.phase,'saved');
});

test('a recorder that never exits is reported with its process, never resumed',async t=>{
  const {r,child,guard,finishes}=await liveRecorder(t);child.ignore.add('SIGINT');child.ignore.add('SIGKILL');
  await r.micFault({...LOST,at:Date.now()},child,guard);
  assert.equal(finishes.length,0);assert.equal(r.state.phase,'error');
  assert.match(r.state.error,new RegExp(`process ${PID}`));assert.ok(r.child,'the process is still accounted for');
});

test('a fault from an older take or a stopped guard changes nothing',async t=>{
  const {r,child,guard,finishes}=await liveRecorder(t);
  assert.equal(r.micFault(LOST,child,{stop(){}}),null,'another guard');
  assert.equal(r.micFault(LOST,new EventEmitter(),guard),null,'another child');
  r.stopSourceGuard();assert.equal(guard.stopped,1);
  assert.equal(r.micFault(LOST,child,guard),null,'a guard already stopped');
  assert.deepEqual(child.signals,[]);assert.deepEqual(finishes,[]);assert.equal(r.state.phase,'recording');
});

test('a fault during an ordinary Stop is contained at once, not after the Stop timeout',async t=>{
  for(const how of ['unconfirmed','confirmed']){
    const {r,g,child,guard,finishes,events}=await liveRecorder(t);
    r.stopMs=30000;// the production Stop timeout
    const stamp=[];const mute=r.muteStream;r.muteStream=async i=>{stamp.push(Date.now());return mute(i);};
    if(how==='unconfirmed'){g.refuse=true;child.ignore.add('SIGINT');}else child.exitDelay=150;
    const stopping=r.stop();
    assert.equal(r.state.phase,'stopping');
    await delay(30);
    const faultAt=Date.now();
    const ending=r.micFault({...LOST,at:faultAt},child,guard);
    assert.ok(ending&&typeof ending.then==='function','the fault takes over the Stop in progress');
    const [a,b]=await Promise.all([stopping,ending]);
    assert.equal(a,b,'Stop and the fault resolve to the same ending');
    assert.ok(stamp.length&&stamp[0]-faultAt<50,`${how}: first mute ${stamp[0]-faultAt} ms after the fault`);
    assert.equal(child.signals.filter(s=>s==='SIGINT').length,1,'the stop request is not repeated');
    assert.equal(finishes.length,1,'saved once');assert.match(finishes[0],/disconnected/);
    if(how==='unconfirmed'){
      const kill=events.findIndex(e=>e[1]==='SIGKILL');assert.ok(kill>0,'killed');
      assert.ok(Date.now()-faultAt<400,`ended ${Date.now()-faultAt} ms after the fault, not after 30 s`);
      assert.equal(r.micFaultInfo.cut,'unconfirmed');
    }else assert.equal(r.micFaultInfo.cut,'muted');
    assert.notEqual(r.state.phase,'recording');
  }
});

test('a fault while stopping normally is kept as the saved reason',async t=>{
  const {r,child,guard,finishes}=await liveRecorder(t);
  r.stopMs=500;
  child.kill=sig=>{child.signals.push(sig);r.micFault(LOST,child,guard);setTimeout(()=>child.emit('exit',0,null),5);return true;};
  await r.stop();
  assert.equal(finishes.length,1);assert.match(finishes[0],/disconnected/);
});

test('a fault while the take is starting is contained at once, not when startup next looks',async t=>{
  const {r,child,guard,finishes,events}=await liveRecorder(t);
  r.state.phase='starting';
  const at=Date.now();
  const ending=r.micFault({...LOST,at},child,guard);
  assert.ok(ending&&typeof ending.then==='function');assert.equal(r.state.phase,'stopping');
  await ending;
  assert.equal(events.find(e=>e[0]==='signal')[1],'SIGINT');assert.ok(events.some(e=>e[0]==='mute'));
  assert.equal(finishes.length,1);assert.match(finishes[0],/disconnected/);
});

test('discard and saving stop the guard',async t=>{
  const a=await liveRecorder(t);await a.r.discard();assert.equal(a.guard.stopped,1);assert.equal(a.r.sourceGuard,null);
});

test('Default is refused when there is no microphone to resolve it to',async t=>{
  for(const v of ['','x.monitor','vidcapture_mic']){
    const {r}=await liveRecorder(t,{defaultSource:async()=>v});
    await assert.rejects(r.resolveDefaultMic(),/no default microphone/);
  }
  const {r}=await liveRecorder(t,{defaultSource:async()=>S.rode});
  assert.equal(await r.resolveDefaultMic(),S.rode);
});

test('earlier uncertainty stays in the record and the message after a later confirmation',async t=>{
  const {r,g,child,guard,finishes}=await liveRecorder(t);
  child.exitDelay=200;g.down=true;setTimeout(()=>{g.down=false;},30);
  r.faultUnsafeMs=150;
  await r.micFault({...LOST,at:Date.now()},child,guard);
  assert.equal(r.micFaultInfo.uncertain,true);assert.ok(r.micFaultInfo.unconfirmedMs>=25,`unconfirmed ${r.micFaultInfo.unconfirmedMs} ms`);
  assert.match(finishes[0],/end of the recording may include another microphone/);
});

test('the unsafe deadline is wall-clock: probes that never answer do not delay the kill',async t=>{
  const hang=()=>new Promise(()=>{});
  const {r,child,guard,events}=await liveRecorder(t,{guardQuery:{sources:hang,sourceOutputs:hang,clients:hang},guardTiming:{intervalMs:15,queryMs:60}});
  r.faultUnsafeMs=20;child.ignore.add('SIGINT');
  const stamps={};const kill=child.kill;const begun=Date.now();
  child.kill=sig=>{stamps[sig]=Date.now()-begun;return kill(sig);};
  await r.micFault({...LOST,at:begun},child,guard);
  assert.ok(stamps.SIGINT<10,`SIGINT at ${stamps.SIGINT} ms`);
  assert.ok(stamps.SIGKILL>=20&&stamps.SIGKILL<45,`SIGKILL at ${stamps.SIGKILL} ms for a 20 ms bound`);
  assert.equal(r.micFaultInfo.killAfterMs>=20&&r.micFaultInfo.killAfterMs<45,true);
  assert.ok(!events.some(e=>e[0]==='mute'),'nothing could be muted, and nothing claims it was');
  assert.equal(r.micFaultInfo.uncertain,true);
});

test('owned probes: a hung pactl is killed, never piles up, and none outlive the guard',async t=>{
  // Real child processes that ignore SIGTERM and never answer, standing in for pactl.
  const {spawn}=require('node:child_process');
  const kids=[];let maxLive=0;
  const pactl=require('../source-guard.cjs').createPactl({spawnImpl:(cmd,args,opts)=>{
    assert.equal(cmd,'pactl');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],opts);kids.push(c);return c;}});
  const sample=setInterval(()=>{maxLive=Math.max(maxLive,pactl.live.size);},5);
  t.after(async()=>{clearInterval(sample);for(const c of kids)try{c.kill('SIGKILL');}catch{}});
  const faults=[];
  const guard=new SourceGuard({plan:micOnly,pid:PID,query:pactl,timing:{intervalMs:20,queryMs:150,unconfirmedMs:360},onFault:f=>faults.push(f)});
  guard.start();
  await delay(700);
  assert.equal(faults.length,1);assert.equal(faults[0].fault,'unknown');
  guard.stop();const drained=await guard.drain(1000);
  assert.deepEqual(drained.unreaped,[]);
  await delay(50);
  assert.ok(kids.length>0&&kids.every(c=>c.exitCode!==null||c.signalCode),`all ${kids.length} probe processes exited`);
  assert.ok(maxLive<=3,`at most one round of three probes alive at once (saw ${maxLive})`);
  assert.ok(kids.length<=12,`probes were not relaunched while earlier ones lived (${kids.length})`);
});

test('a failure while saving a faulted take is reported, never left stopping or unhandled',async t=>{
  const {r,child,guard}=await liveRecorder(t);
  r.finish=Recorder.prototype.finish;// the real finish and finalize
  r.writeLog=async()=>{throw new Error('log write failed');};
  const unhandled=[];const onU=e=>unhandled.push(e);process.on('unhandledRejection',onU);
  t.after(()=>process.removeListener('unhandledRejection',onU));
  const ending=r.micFault({...LOST,at:Date.now()},child,guard);
  await ending;await delay(20);
  assert.deepEqual(unhandled,[]);
  assert.equal(r.state.phase,'error');assert.equal(r.faulting,null);
  assert.match(r.state.error,/microphone was disconnected/);assert.match(r.state.error,/Saving the recording failed: log write failed/);
  assert.doesNotMatch(r.state.error,/part recorded before that was saved/);
  assert.ok(r.rawFile,'the file is still tracked');
});

test('containment starts no probe after its ending has drained',async t=>{
  const {spawn}=require('node:child_process');
  const kids=[],launches=[];let exitChild,reads=0;
  const pactl=require('../source-guard.cjs').createPactl({spawnImpl:(cmd,args,opts)=>{
    launches.push({at:Date.now(),args});
    let script;
    if(args[0]==='set-source-output-mute'){setTimeout(()=>exitChild(),20);script="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";}
    else if(++reads<=3){const kind=args.at(-1);const val=kind==='sources'?[{index:1,name:'mic'}]:kind==='clients'?[]:[{index:2,source:1,mute:false,properties:{'application.process.id':String(PID)}}];script='process.stdout.write('+JSON.stringify(JSON.stringify(val))+')';}
    else script="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";// later reads hang
    const c=spawn(process.execPath,['-e',script],opts);kids.push(c);return c;}});
  t.after(()=>{for(const c of kids)try{c.kill('SIGKILL');}catch{}});
  const {r,child,guard,finishes}=await liveRecorder(t,{guardQuery:pactl,pactl,muteStream:i=>pactl.mute(i,800),guardTiming:{intervalMs:10,queryMs:800}});
  r.faultUnsafeMs=400;r.faultStopMs=600;child.ignore.add('SIGINT');
  exitChild=()=>child.emit('exit',0,null);
  await r.micFault({...LOST,at:Date.now()},child,guard);
  const ended=Date.now();
  assert.equal(finishes.length,1);
  assert.equal(pactl.live.size,0,'no probe is running when the ending returns');
  await delay(100);
  assert.ok(!launches.some(l=>l.at>ended),'nothing was launched after the ending');
  assert.equal(pactl.live.size,0);
});
