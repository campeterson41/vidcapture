// A zero stream volume on the recorder's microphone stream is resolved against that
// stream's own PipeWire node before the indicator claims muted (take-meter.cjs,
// resolveZero). The PipeWire graph is a fake; the node query is either a fake or a
// real child process of this test that prints or withholds JSON. No device, stream or
// audio server is touched.
//
// The fixture is a minimal, sanitized copy of values observed in an isolated native
// run: the recorder stream as pactl lists it (both channels at 0) and its node as
// pw-dump prints it (volume 1, no channel or soft volumes, nothing muted), while the
// recorded track carried the selected tone. Host and machine identifiers are omitted.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {spawn:realSpawn}=require('node:child_process');
const {TakeMeter,readGraph,resolveZero}=require('../take-meter.cjs');

const PID=4242,MIC='vc_sel';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=1500){const end=Date.now()+ms;while(Date.now()<end){if(fn())return true;await delay(5);}return false;}
const clone=x=>JSON.parse(JSON.stringify(x));

const ZERO2={'front-left':{value:0,value_percent:'0%',db:'-inf dB'},'front-right':{value:0,value_percent:'0%',db:'-inf dB'}};
const source=()=>({index:49,name:MIC,mute:false,volume:{mono:{value:65536,value_percent:'100%',db:'0.00 dB'}},properties:{'media.class':'Audio/Source'}});
const output=(more={})=>({index:123,source:49,sample_specification:'s32le 2ch 48000Hz',channel_map:'front-left,front-right',corked:false,mute:false,volume:clone(ZERO2),
  properties:{'application.process.id':String(PID),'application.process.binary':'gpu-screen-recorder','client.id':'54','object.id':'53','object.serial':'123','node.name':'gsr-vc_sel','media.class':'Stream/Input/Audio','state.restore-props':'false','node.dont-fallback':'true'},...more});
const OBSERVED_PROPS={volume:1,mute:false,channelVolumes:[],channelMap:[],softMute:false,softVolumes:[],monitorMute:false,monitorVolumes:[]};
const node=(props=OBSERVED_PROPS,more={})=>({id:53,type:'PipeWire:Interface:Node',version:3,
  info:{state:'running',props:{'application.process.id':PID,'client.id':54,'node.name':'gsr-vc_sel','object.id':53,'object.serial':123,'media.class':'Stream/Input/Audio',...(more.props||{})},
    params:{Props:props==='absent'?undefined:[props].filter(x=>x!==null)}},...(more.top||{})});
const graph=(outputs=[output()],sources=[source()])=>({sources,outputs,clients:[],pid:PID,expect:MIC});
const want=()=>readGraph(graph()).nodes[0];

test('the observed empty-array stream is not muted: it resolves to ok against its own node',()=>{
  const g=readGraph(graph());
  assert.equal(g.state,'zero');assert.equal(g.source,MIC);
  assert.deepEqual(g.nodes,[{id:'53',serial:'123',index:123,client:'54',name:'gsr-vc_sel',pid:String(PID)}]);
  assert.equal(resolveZero([node()],g.nodes[0]),'ok');
  // pw-dump of one id may carry other objects too; only the exact node counts.
  assert.equal(resolveZero([{id:1,type:'PipeWire:Interface:Core'},node()],g.nodes[0]),'ok');
});

test('actual zero gain or mute on the node still resolves to muted',()=>{
  const p=x=>({...OBSERVED_PROPS,...x});
  for(const [why,props] of [
    ['explicit mute',p({mute:true})],
    ['soft mute',p({softMute:true})],
    ['scalar zero',p({volume:0})],
    ['channel volumes all zero',p({channelVolumes:[0,0]})],
    ['soft volumes all zero',p({softVolumes:[0,0]})],
    ['soft zero with unset channels',p({softVolumes:[0]})],
  ])assert.equal(resolveZero([node(props)],want()),'muted',why);
});

test('set channel volumes that are not all zero contradict the zero report: unknown, not ok',()=>{
  assert.equal(resolveZero([node({...OBSERVED_PROPS,channelVolumes:[0,0.5]})],want()),'unknown');
  assert.equal(resolveZero([node({...OBSERVED_PROPS,channelVolumes:[1,1]})],want()),'unknown');
  // Mixed channels reported by pactl itself are not zero: no resolution is needed.
  const mixed=output({volume:{'front-left':{value:0},'front-right':{value:30000}}});
  assert.deepEqual(readGraph(graph([mixed])),{state:'ok',source:MIC});
});

test('missing or malformed Props are unknown',()=>{
  const p=x=>({...OBSERVED_PROPS,...x});
  const cases=[
    ['no Props param',node('absent')],
    ['empty Props',node(null)],
    ['Props not an array',(()=>{const n=node();n.info.params.Props={volume:1};return n;})()],
    ['two Props entries',(()=>{const n=node();n.info.params.Props.push(p({}));return n;})()],
    ['mute missing',node((({mute,...r})=>r)(OBSERVED_PROPS))],
    ['softMute missing',node((({softMute,...r})=>r)(OBSERVED_PROPS))],
    ['volume a string',node(p({volume:'1'}))],
    ['volume negative',node(p({volume:-1}))],
    ['channelVolumes missing',node((({channelVolumes,...r})=>r)(OBSERVED_PROPS))],
    ['channelVolumes with null',node(p({channelVolumes:[null,1]}))],
    ['softVolumes not an array',node(p({softVolumes:1}))],
  ];
  for(const [why,n] of cases)assert.equal(resolveZero([n],want()),'unknown',why);
  for(const bad of [null,undefined,{},'[]',[]])assert.equal(resolveZero(bad,want()),'unknown');
});

test('a node that is not exactly this stream is unknown',()=>{
  const cases=[
    ['another object id',node(OBSERVED_PROPS,{top:{id:54}})],
    ['another serial',node(OBSERVED_PROPS,{props:{'object.serial':124}})],
    ['another process',node(OBSERVED_PROPS,{props:{'application.process.id':PID+1}})],
    ['another client',node(OBSERVED_PROPS,{props:{'client.id':55}})],
    ['another name',node(OBSERVED_PROPS,{props:{'node.name':'gsr-other'}})],
    ['not a capture stream',node(OBSERVED_PROPS,{props:{'media.class':'Audio/Source'}})],
    ['not a node',node(OBSERVED_PROPS,{top:{type:'PipeWire:Interface:Port'}})],
  ];
  for(const [why,n] of cases)assert.equal(resolveZero([n],want()),'unknown',why);
  // Two objects with the stream's id: which one is meant is not known.
  assert.equal(resolveZero([node(),node()],want()),'unknown');
  // The pactl stream itself lacks identity, or its index is not its serial.
  for(const drop of ['object.id','object.serial','client.id']){
    const o=output();delete o.properties[drop];
    assert.equal(resolveZero([node()],readGraph(graph([o])).nodes[0]),'unknown',`pactl ${drop} missing`);
  }
  assert.equal(resolveZero([node()],readGraph(graph([output({index:124})])).nodes[0]),'unknown','index is not the serial');
});

test('everything decided before the stream volume is unchanged and needs no node query',()=>{
  // Corked with zero volume: held.
  assert.equal(readGraph(graph([output({corked:true})])).state,'held');
  // Stream mute with zero volume: muted from pactl alone.
  assert.equal(readGraph(graph([output({mute:true})])).state,'muted');
  // Source muted or at zero: muted from pactl alone.
  const sm=source();sm.mute=true;assert.equal(readGraph(graph([output()],[sm])).state,'muted');
  const sz=source();sz.volume={mono:{value:0}};assert.equal(readGraph(graph([output()],[sz])).state,'muted');
  // Two owned streams on the source, one zero and one not: ambiguous, never resolved.
  const other=output({index:124,volume:{mono:{value:65536}}});
  assert.deepEqual(readGraph(graph([output(),other])),{state:'unavailable',reason:'ambiguous'});
  // Not on the expected source: unlinked, never resolved.
  assert.equal(readGraph({...graph(),expect:'vc_other'}).state,'unlinked');
});

// Meter behavior with a fake graph and fake level reader.
function fakeSpawn(){
  const spawned=[];
  const fn=(cmd,args)=>{const c=new EventEmitter();c.cmd=cmd;c.args=args;c.stdout=new EventEmitter();c.killed=false;c.kill=()=>{c.killed=true;queueMicrotask(()=>c.emit('exit',0));};spawned.push(c);return c;};
  fn.spawned=spawned;fn.readers=()=>spawned.filter(c=>c.cmd==='parec'&&!c.killed);
  return fn;
}
const pcm=(a,n=160)=>{const b=Buffer.alloc(n*2);for(let i=0;i<n;i++)b.writeInt16LE(i%2?a:-a,i*2);return b;};
function fakeGraph(dump=()=>[node()]){
  const g={outputs:[output()],srcs:[source()],propsCalls:[],
    sources:async()=>g.srcs,sourceOutputs:async()=>g.outputs,clients:async()=>[],
    props:async(id,o)=>{g.propsCalls.push(id);return dump(id,o);}};
  return g;
}
const FAST={statusMs:40,queryMs:30,tickMs:10,quietMs:60,staleMs:50,graceMs:100};
function meter(query,spawn,timing=FAST){const states=[];const m=new TakeMeter({onUpdate:x=>states.push(x),spawn,query,timing});m.states=states;m.lastState=()=>states.at(-1)?.state;return m;}

test('replay: the observed stream shows the tone as live instead of muted',async t=>{
  const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.readers().length===1),'the level reader starts on the resolved source');
  assert.deepEqual(sp.readers()[0].args.slice(0,2),['--device',MIC]);
  assert.deepEqual(g.propsCalls.slice(0,1),['53'],'the stream\'s own node is asked');
  const r=sp.readers()[0];const feed=setInterval(()=>r.stdout.emit('data',pcm(1860)),5);t.after(()=>clearInterval(feed));// about -25 dBFS
  assert.ok(await until(()=>m.lastState()==='live'));
  assert.ok(!m.states.some(s=>s.state==='muted'),'never claimed muted');
});

test('actual zero gain or mute on the node shows muted and starts no reader',async t=>{
  for(const props of [{...OBSERVED_PROPS,mute:true},{...OBSERVED_PROPS,volume:0},{...OBSERVED_PROPS,channelVolumes:[0,0]},{...OBSERVED_PROPS,softMute:true}]){
    const g=fakeGraph(()=>[node(props)]),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>m.lastState()==='muted'),JSON.stringify(props));
    await delay(FAST.statusMs*2);
    assert.equal(sp.readers().length,0);assert.ok(!m.states.some(s=>s.state==='live'||s.state==='quiet'));
    m.stop();
  }
});

test('a failed, malformed or mismatched node answer is unavailable, never live or muted',async t=>{
  const answers=[
    ()=>{throw new Error('pw-dump unavailable');},
    ()=>[node('absent')],
    ()=>[node(OBSERVED_PROPS,{props:{'application.process.id':PID+1}})],
    ()=>[node(OBSERVED_PROPS,{props:{'object.serial':999}})],
    ()=>new Promise(()=>{}),// never answers: cut off at queryMs
  ];
  for(const a of answers){
    const g=fakeGraph(a),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>m.lastState()==='unavailable'));
    await delay(FAST.statusMs*2);
    assert.equal(sp.readers().length,0);
    assert.ok(m.states.every(s=>s.state==='checking'||s.state==='unavailable'),JSON.stringify(m.states));
    m.stop();
  }
});

test('a node answer that arrives after stop or a new take is dropped',async t=>{
  let release;const g=fakeGraph(()=>new Promise(r=>{release=()=>r([node()]);})),sp=fakeSpawn();
  const m=meter(g,sp,{...FAST,queryMs:1000,statusMs:2000});t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>g.propsCalls.length===1));
  m.sync({pid:PID+1,phase:'recording',expect:MIC});// a new take by another recorder
  const n=m.states.length;release();await delay(20);
  // The new recorder owns no stream here, so it may show unlinked; the old take's
  // answer must not show anything about the microphone.
  assert.ok(m.states.slice(n).every(s=>s.state==='checking'||s.state==='unlinked'),JSON.stringify(m.states.slice(n)));
  assert.equal(sp.readers().length,0);
  // And after stop nothing is sent at all.
  const g2=fakeGraph(()=>new Promise(r=>{release=()=>r([node()]);})),m2=meter(g2,fakeSpawn(),{...FAST,queryMs:1000,statusMs:2000});
  m2.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>g2.propsCalls.length===1));
  m2.stop();const k=m2.states.length;release();await delay(20);
  assert.equal(m2.states.length,k);
});

// The node query as a real process owned by the meter. The program is a Node child
// that ignores SIGTERM: it either prints a pw-dump answer or never answers.
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function nodeQuerySpawn(mode){
  const fake=fakeSpawn(),dumps=[];
  const fn=(cmd,args,opts)=>{
    if(cmd!=='pw-dump')return fake(cmd,args,opts);
    const body=mode==='answer'?`process.stdout.write(${JSON.stringify(JSON.stringify([node()]))});`:'setInterval(()=>{},1000);';
    const c=realSpawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});${body}`],{stdio:['ignore','pipe','ignore']});
    c.args=args;dumps.push(c);return c;
  };
  fn.fake=fake;fn.dumps=dumps;return fn;
}
const graphOnly=()=>{const g=fakeGraph();delete g.props;return g;};

test('real node query: its answer is parsed and the reader starts',async t=>{
  const sp=nodeQuerySpawn('answer'),m=meter(graphOnly(),sp,{...FAST,queryMs:2000,statusMs:3000});
  t.after(()=>{m.stop();for(const c of sp.dumps)try{c.kill('SIGKILL');}catch{}});
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.fake.readers().length===1,4000));
  assert.deepEqual(sp.dumps[0].args,['-N','53']);
  assert.equal(m.probes.size,0,'the finished query is no longer tracked');
});

test('real hung node query: killed at its deadline, one at a time, nothing left after stop',async t=>{
  const sp=nodeQuerySpawn('hang'),m=meter(graphOnly(),sp,{...FAST,queryMs:150,statusMs:40});
  t.after(()=>{m.stop();for(const c of sp.dumps)try{c.kill('SIGKILL');}catch{}});
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.dumps.length>=1));
  const first=sp.dumps[0];
  // Polls every 40 ms but a check waits for its query: never more than one alive.
  let most=0;const end=Date.now()+400;
  while(Date.now()<end){most=Math.max(most,sp.dumps.filter(c=>alive(c.pid)&&c.exitCode===null&&!c.signalCode).length,m.probes.size);await delay(5);}
  assert.ok(most<=1,`at most one node query at a time (saw ${most})`);
  assert.ok(await until(()=>!alive(first.pid)||first.signalCode==='SIGKILL'),'the first query was SIGKILLed at its deadline');
  assert.equal(first.signalCode,'SIGKILL');
  assert.equal(m.lastState(),'unavailable');
  assert.equal(sp.fake.readers().length,0);
  m.stop();
  const started=Date.now();const drained=await m.drain();
  assert.ok(Date.now()-started<FAST.graceMs+250+200);
  assert.deepEqual(drained,{unconfirmed:[]});
  assert.equal(m.probes.size,0);
  for(const c of sp.dumps)assert.equal(alive(c.pid)&&c.exitCode===null&&!c.signalCode,false,`query ${c.pid} is gone`);
});

test('pause and take replacement end a hung node query at once',async t=>{
  for(const end of [m=>m.sync({pid:PID,phase:'paused',expect:MIC}),m=>m.sync({pid:PID+1,phase:'recording',expect:MIC})]){
    const sp=nodeQuerySpawn('hang'),m=meter(graphOnly(),sp,{...FAST,queryMs:5000,statusMs:10000});
    t.after(()=>{m.stop();for(const c of sp.dumps)try{c.kill('SIGKILL');}catch{}});
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>m.probes.size===1));
    const q=sp.dumps[0];
    end(m);
    assert.ok(await until(()=>q.signalCode==='SIGKILL',1000),'killed well before its 5 s deadline');
    m.stop();assert.deepEqual(await m.drain(),{unconfirmed:[]});
  }
});

// Review cases for the asynchronous node query.

test('a graph change while the node query is pending is reported as it is now, not as the old answer',async t=>{
  const changes=[
    ['stream muted',g=>{g.outputs=[output({mute:true})];},'muted'],
    ['stream corked',g=>{g.outputs=[output({corked:true})];},'held'],
    ['source muted',g=>{const s=source();s.mute=true;g.srcs=[s];},'muted'],
    ['moved to another source',g=>{g.srcs=[source(),{...source(),index:50,name:'vc_other'}];g.outputs=[output({source:50})];},'unlinked'],
    ['stream gone',g=>{g.outputs=[];},'unlinked'],
    ['replaced by a new zero stream',g=>{const o=output({index:124});o.properties['object.serial']='124';o.properties['object.id']='60';g.outputs=[o];},'unavailable'],
  ];
  for(const [why,change,expected] of changes){
    let release;const g=fakeGraph(()=>new Promise(r=>{release=()=>r([node()]);})),sp=fakeSpawn();
    const m=meter(g,sp,{...FAST,queryMs:1000,statusMs:5000});t.after(()=>m.stop());
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>g.propsCalls.length===1),why);
    change(g);release();
    assert.ok(await until(()=>m.lastState()===expected),`${why}: ${JSON.stringify(m.states)}`);
    await delay(20);
    assert.equal(sp.readers().length,0,`${why}: no reader from the old answer`);
    assert.ok(!m.states.some(s=>s.state==='live'||s.state==='quiet'),why);
    m.stop();
  }
  // Nothing changed while pending: the answer stands and the reader starts.
  let release;const g=fakeGraph(()=>new Promise(r=>{release=()=>r([node()]);})),sp=fakeSpawn();
  const m=meter(g,sp,{...FAST,queryMs:1000,statusMs:5000});t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>g.propsCalls.length===1));release();
  assert.ok(await until(()=>sp.readers().length===1));
});

// A node query process under the test's full control: it never exits unless told.
function controlledSpawn({pid=987654}={}){
  const fake=fakeSpawn(),dumps=[];
  const fn=(cmd,args,opts)=>{
    if(cmd!=='pw-dump')return fake(cmd,args,opts);
    const c=new EventEmitter();c.pid=pid===null?undefined:pid+dumps.length;c.args=args;c.stdout=new EventEmitter();c.exitCode=null;c.signals=[];
    c.kill=sig=>{c.signals.push(sig);};// ignores every signal until close is emitted
    c.finish=()=>{c.exitCode=null;c.signalCode='SIGKILL';c.emit('exit',null,'SIGKILL');c.emit('close',null,'SIGKILL');};
    dumps.push(c);return c;
  };
  fn.fake=fake;fn.dumps=dumps;return fn;
}

test('an error event from a started query does not untrack it; only its close does',async t=>{
  const sp=controlledSpawn(),m=meter(graphOnly(),sp,{...FAST,queryMs:2000,statusMs:5000});t.after(()=>{m.stop();for(const c of sp.dumps)c.finish();});
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.dumps.length===1));
  const q=sp.dumps[0];
  q.emit('error',new Error('EPIPE'));
  await delay(20);
  assert.equal(m.probes.size,1,'still tracked while its pid may exist');
  assert.deepEqual(q.signals,['SIGKILL'],'killed on error');
  q.finish();
  assert.ok(await until(()=>m.probes.size===0));
  assert.ok(await until(()=>m.lastState()==='unavailable'));
  assert.equal(sp.fake.readers().length,0);
  // A spawn failure (no pid) is settled at once.
  const sp2=controlledSpawn({pid:null}),m2=meter(graphOnly(),sp2,{...FAST,queryMs:2000,statusMs:5000});t.after(()=>m2.stop());
  m2.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp2.dumps.length===1));
  sp2.dumps[0].emit('error',Object.assign(new Error('spawn pw-dump ENOENT'),{code:'ENOENT'}));
  assert.ok(await until(()=>m2.probes.size===0&&m2.lastState()==='unavailable'));
});

test('a query whose exit is never seen stays tracked across stop and a new take, and no new ones pile up',async t=>{
  const sp=controlledSpawn(),m=meter(graphOnly(),sp,{...FAST,queryMs:60,statusMs:20,graceMs:50});t.after(()=>{m.stop();for(const c of sp.dumps)c.finish();});
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>sp.dumps.length===1));
  const q=sp.dumps[0];
  m.stop();
  assert.equal(m.probes.size,1,'stop does not forget it');
  const drained=await m.drain();
  assert.deepEqual(drained,{unconfirmed:[q.pid]},'reported unconfirmed');
  // A new take polls every 20 ms with a 60 ms deadline: still only the one process.
  m.sync({pid:PID,phase:'recording',expect:MIC});
  await delay(300);
  assert.equal(sp.dumps.length,1,'no fresh query while the earlier one is unconfirmed');
  assert.equal(m.lastState(),'unavailable');
  assert.equal(sp.fake.readers().length,0);
  assert.ok(q.signals.length>=1&&q.signals.every(s=>s==='SIGKILL'));
  // Once its close is seen, the next check may ask again.
  q.finish();
  assert.ok(await until(()=>sp.dumps.length===2));
  assert.ok(m.probes.size<=1);
});

test('a stream without a complete identity is unknown and starts no query',async t=>{
  for(const drop of ['object.id','object.serial','client.id','node.name']){
    const g=fakeGraph(),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
    const o=output();delete o.properties[drop];g.outputs=[o];
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>m.lastState()==='unavailable'),drop);
    await delay(FAST.statusMs*2);
    assert.equal(g.propsCalls.length,0,`${drop}: no node query`);
    assert.equal(sp.spawned.length,0);
    m.stop();
  }
  // Invalid values, and an index that is not the serial, also start nothing.
  for(const [why,edit] of [['id not a number',o=>{o.properties['object.id']='53;x';}],['serial not the index',o=>{o.index=999;}]]){
    const g=fakeGraph(),sp=controlledSpawn(),m=meter(graphOnly(),sp);t.after(()=>m.stop());
    const o=output();edit(o);g.outputs=[o];m.query=g;delete g.props;
    m.sync({pid:PID,phase:'recording',expect:MIC});
    assert.ok(await until(()=>m.lastState()==='unavailable'),why);
    await delay(FAST.statusMs*2);
    assert.equal(sp.dumps.length,0,`${why}: no process`);
    m.stop();
  }
});

test('Props must be exactly one valid entry: extra, partial, null or conflicting entries are unknown',()=>{
  const ok=OBSERVED_PROPS;
  const withProps=list=>{const n=node();n.info.params.Props=clone(list);return n;};
  assert.equal(resolveZero([withProps([ok])],want()),'ok','the single observed entry still resolves');
  const cases=[
    ['valid then partial mute',[ok,{mute:true}]],
    ['partial mute then valid',[{mute:true},ok]],
    ['valid then partial zero volume',[ok,{volume:0}]],
    ['valid then soft zero only',[ok,{softVolumes:[0,0]}]],
    ['valid then null',[ok,null]],
    ['null then valid',[null,ok]],
    ['valid then empty object',[ok,{}]],
    ['valid then a number',[ok,1]],
    ['conflicting full entries',[{...ok,mute:true},ok]],
    ['two identical entries',[ok,ok]],
    ['a nested array',[[ok]]],
    ['a single null',[null]],
    ['a single partial entry',[{mute:false,volume:1}]],
  ];
  for(const [why,list] of cases)assert.equal(resolveZero([withProps(list)],want()),'unknown',why);
});

test('a conflicting extra Props entry is unavailable in the meter, never live',async t=>{
  const n=node();n.info.params.Props=[clone(OBSERVED_PROPS),{mute:true}];
  const g=fakeGraph(()=>[n]),sp=fakeSpawn(),m=meter(g,sp);t.after(()=>m.stop());
  m.sync({pid:PID,phase:'recording',expect:MIC});
  assert.ok(await until(()=>m.lastState()==='unavailable'));
  await delay(FAST.statusMs*2);
  assert.equal(sp.readers().length,0);
  assert.ok(m.states.every(s=>s.state==='checking'||s.state==='unavailable'),JSON.stringify(m.states));
});
