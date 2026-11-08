'use strict';
// Keeps a take on the microphone it started with.
//
// When the chosen microphone goes away, PipeWire may connect the recorder to another
// input instead: GPU Screen Recorder opens a new capture stream by the old device name
// and the server falls back to the default microphone, while the stream keeps its old
// name. So a stream's name never proves what it is recording. This guard reads the
// actual route of every capture stream the recorder process owns (and, with live
// cleanup, of the cleanup process's input) and ends the take when:
//   lost     a microphone source the take reads has gone
//   moved    an owned capture stream is reading a source the take did not choose
//   unknown  the route could not be confirmed for longer than the deadline (PipeWire
//            did not answer, the expected stream is missing, or the cleaned source is
//            no longer owned by this take's cleanup process)
// Quiet input, mute and pause are not faults: they do not change the route.
// It is a polling check, so it bounds rather than removes the time between a loss and
// the stop; the stream policy set by the recorder (node.dont-fallback) is what refuses
// the fallback inside PipeWire itself. Nothing here changes defaults or any stream
// that this take's own processes do not own.
const {spawn:nodeSpawn}=require('node:child_process');

const TIMING={intervalMs:250,queryMs:1000,unconfirmedMs:3000};
const REAP_MS=500;// how long stop/drain waits for killed probes to be reaped
const MAX_OUTPUT=16*1024*1024;

// pactl as processes this module owns. Each probe is killed with SIGKILL (which a
// process cannot ignore) at its deadline, settles only once its process has exited,
// and is tracked until reaped, so nothing it starts outlives the guard or the take.
// spawnImpl replaces the program in tests.
function createPactl({spawnImpl=nodeSpawn}={}){
  const live=new Set();
  const exec=(args,timeout)=>new Promise((resolve,reject)=>{
    let child;
    try{child=spawnImpl('pactl',args,{stdio:['ignore','pipe','ignore']});}catch(e){reject(e);return;}
    live.add(child);
    let out='',timedOut=false;
    const kill=()=>{try{child.kill('SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},timeout);
    child.stdout?.on('data',d=>{out+=d;if(out.length>MAX_OUTPUT)kill();});
    child.once('error',e=>{clearTimeout(timer);live.delete(child);reject(e);});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);live.delete(child);
      if(timedOut)reject(new Error('timed out'));
      else if(code===0)resolve(out);
      else reject(new Error(`pactl ended with ${code??signal}`));
    });
  });
  const list=kind=>o=>exec(['-f','json','list',kind],o.timeout).then(JSON.parse);
  return {
    live,
    sources:list('sources'),sourceOutputs:list('source-outputs'),clients:list('clients'),
    mute:(index,timeout=TIMING.queryMs)=>exec(['set-source-output-mute',String(index),'1'],timeout),
    // Kills every probe still running and waits (bounded) for them to be reaped.
    // Returns the process ids that had not exited by then.
    async drain(ms=REAP_MS){
      const pending=[...live];
      for(const c of pending){try{c.kill('SIGKILL');}catch{}}
      await Promise.race([Promise.all(pending.map(c=>c.exitCode!==null||c.signalCode?null:new Promise(r=>c.once('close',r)))),new Promise(r=>setTimeout(r,ms))]);
      return {unreaped:pending.filter(c=>c.exitCode===null&&!c.signalCode).map(c=>c.pid)};
    },
  };
}

function within(promise,ms){
  let t;
  return Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('timed out')),ms);})]).finally(()=>clearTimeout(t));
}
const props=x=>x?.properties||{};
const isMonitor=s=>!!s&&(String(s.name||'').endsWith('.monitor')||props(s)['device.class']==='monitor'||(s.monitor_of_sink!=null&&s.monitor_of_sink!==''&&s.monitor_of_sink!=='n/a'));

// The route a take must keep, from its settings. mic is the resolved microphone
// source name (Default is resolved to one source when the take starts), clean the
// cleaned source when live cleanup is on, chainPid the cleanup process.
function takePlan({settings,mic,clean=null,chainPid=null}){
  if(!settings||settings.microphone==='none'||!mic)return null;
  const backup=!!(clean&&settings.micBackup);
  const recorder=clean?(backup?[clean,mic]:[clean]):[mic];
  return {
    mic,clean:clean||null,
    sources:[...new Set([mic,...(clean?[clean]:[])])],
    recorder:{expect:recorder,allowed:recorder,monitors:!!settings.systemAudio},
    chain:clean?{pid:chainPid,expect:[mic],allowed:[mic],output:clean}:null,
  };
}

function ownedBy(pid,clients){
  const p=String(pid);
  const owners=new Set(clients.filter(c=>props(c)['pipewire.sec.pid']===p||props(c)['application.process.id']===p).map(c=>String(props(c)['object.id'])).filter(id=>id!=='undefined'));
  return n=>props(n)['application.process.id']===p||(props(n)['client.id']!=null&&owners.has(String(props(n)['client.id'])));
}

// One process's capture streams against what it may read. Returns a fault, an
// unconfirmed reason, or null when every expected route is confirmed.
function checkProcess({pid,part,sources,outputs,clients,who}){
  const owned=ownedBy(pid,clients);
  const byIndex=new Map(sources.map(s=>[s.index,s]));
  const mine=outputs.filter(owned);
  const reading=new Set();
  for(const o of mine){
    const src=byIndex.get(o.source);
    if(!src)return {unconfirmed:`${who}-stream-unrouted`};
    if(isMonitor(src)){
      if(part.monitors)continue;
      return {fault:'moved',who,stream:o.index,to:src.name};
    }
    if(!part.allowed.includes(src.name))return {fault:'moved',who,stream:o.index,to:src.name};
    reading.add(src.name);
  }
  const missing=part.expect.filter(n=>!reading.has(n));
  if(missing.length)return {unconfirmed:`${who}-no-stream`,missing};
  return null;
}

// Pure check of one PipeWire answer against a plan.
function evaluate({plan,pid,sources,outputs,clients}){
  const names=new Set(sources.filter(s=>!isMonitor(s)).map(s=>s.name));
  const gone=plan.sources.filter(n=>!names.has(n));
  if(gone.length)return {ok:false,fault:'lost',source:gone[0],cleanup:gone[0]===plan.clean};
  const rec=checkProcess({pid,part:plan.recorder,sources,outputs,clients,who:'recorder'});
  if(rec?.fault)return {ok:false,...rec};
  let chain=null;
  if(plan.chain){
    if(!plan.chain.pid)chain={unconfirmed:'cleanup-process'};
    else{
      const owned=ownedBy(plan.chain.pid,clients);
      const out=sources.find(s=>s.name===plan.chain.output);
      chain=checkProcess({pid:plan.chain.pid,part:{...plan.chain,monitors:false},sources,outputs,clients,who:'cleanup'});
      if(chain?.fault)return {ok:false,...chain};
      if(!chain&&!(out&&owned(out)))chain={unconfirmed:'cleanup-not-owned'};
    }
  }
  const pending=rec||chain;
  if(pending)return {ok:null,reason:pending.unconfirmed};
  return {ok:true};
}

class SourceGuard{
  // onFault is called at most once, with the fault and the guard's own token, so a
  // caller can ignore a guard that belongs to an older take.
  // query is the PipeWire adapter: by default pactl probes owned by this guard.
  constructor({plan,pid,onFault,query=null,timing={},now=Date.now}){
    this.plan=plan;this.pid=pid;this.onFault=onFault;this.query=query||createPactl();
    this.timing={...TIMING,...timing};this.now=now;
    this.timer=null;this.current=null;this.stopped=false;this.faulted=null;
    this.confirmedAt=null;this.startedAt=null;this.lastReason=null;this.checks=0;this.outstanding=0;
  }
  start(){
    if(this.timer||this.stopped)return;
    this.startedAt=this.now();
    this.timer=setInterval(()=>{this.tick();},this.timing.intervalMs);this.timer.unref?.();
    this.tick();
  }
  // Stops checking and kills any probe still running. drain() waits for them.
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.query.drain?.(0);}
  drain(ms){return this.query.drain?this.query.drain(ms):Promise.resolve({unreaped:[]});}
  // One check. A new check starts only when the last one has settled and every probe
  // process it started has exited, so at most one round of probes is ever running.
  // A check that finishes after stop() does nothing.
  tick(){
    if(this.stopped||this.current)return this.current||Promise.resolve(null);
    // Earlier work still unsettled (a probe process not yet reaped, or an adapter call
    // that never answered): nothing new is launched, but the deadline still applies.
    if(this.query.live?.size||this.outstanding){
      const since=this.confirmedAt??this.startedAt;
      if(this.now()-since>=this.timing.unconfirmedMs)return Promise.resolve(this.fault({ok:false,fault:'unknown',reason:'no-answer'}));
      return Promise.resolve(null);
    }
    const askedAt=this.now();
    const track=p=>{this.outstanding++;return Promise.resolve(p).finally(()=>{this.outstanding--;});};
    const work=(async()=>{
      let verdict;
      try{
        const ms=this.timing.queryMs;
        const [sources,outputs,clients]=await within(Promise.all([track(this.query.sources({timeout:ms})),track(this.query.sourceOutputs({timeout:ms})),track(this.query.clients({timeout:ms}))]),ms);
        verdict=evaluate({plan:this.plan,pid:this.pid,sources,outputs,clients});
      }catch{verdict={ok:null,reason:'no-answer'};}
      if(this.stopped)return null;
      this.checks++;
      if(verdict.ok===true){this.confirmedAt=askedAt;this.lastReason=null;return verdict;}
      if(verdict.ok===false)return this.fault(verdict);
      this.lastReason=verdict.reason;
      // Unconfirmed: allowed only for a bounded time since the last confirmed route
      // (or since the guard started, which covers the recorder opening its streams).
      const since=this.confirmedAt??this.startedAt;
      if(this.now()-since>=this.timing.unconfirmedMs)return this.fault({ok:false,fault:'unknown',reason:verdict.reason});
      return verdict;
    })().finally(()=>{if(this.current===work)this.current=null;});
    this.current=work;
    return work;
  }
  fault(verdict){
    if(this.faulted||this.stopped)return verdict;
    this.faulted={...verdict,at:this.now()};
    this.stop();
    try{this.onFault?.(this.faulted,this);}catch{}
    return verdict;
  }
}

// The explanation a take keeps when the guard ends it.
// The saved-file clause is added last, so finalization can drop it when the file
// could not be validated and say what happened instead.
const SAVED=' The part recorded before that was saved.';
function faultMessage(f,cut=null){
  const unsure=cut==='unconfirmed'?' VidCapture could not confirm the microphone was muted at once, so the end of the recording may include another microphone.':'';
  let reason;
  if(f?.fault==='lost'&&f.cleanup)reason='Microphone cleanup stopped, so the recording was stopped instead of switching to another microphone.';
  else if(f?.fault==='lost')reason='The microphone was disconnected, so the recording was stopped instead of switching to another microphone.';
  else if(f?.fault==='moved')reason='The recording started reading a different microphone, so it was stopped.';
  else reason='VidCapture could not confirm which microphone was being recorded, so the recording was stopped.';
  return reason+unsure+SAVED;
}
const withoutSaved=m=>m&&m.endsWith(SAVED)?m.slice(0,-SAVED.length):m;

// Stream policy for the recorder process. libpulse carries PULSE_PROP onto every
// stream the process opens.
//   node.dont-fallback=true   WirePlumber refuses a stream whose named source is
//                             missing instead of moving it to the default input
//                             (linking/find-defined-target.lua).
//   state.restore-props=false WirePlumber neither restores nor saves this stream's
//                             volume and mute (node/state-stream.lua), so muting a
//                             faulted take's stream never carries over to a later take.
const PIN={'node.dont-fallback':'true','state.restore-props':'false'};
function pinEnv(env){
  let cur=String(env.PULSE_PROP||'');
  for(const k of Object.keys(PIN))cur=cur.split(/\s+/).filter(x=>x&&!x.startsWith(k+'=')).join(' ');
  const add=Object.entries(PIN).map(([k,v])=>`${k}=${v}`).join(' ');
  return {...env,PULSE_PROP:(cur?cur+' ':'')+add};
}

// The recorder's own microphone capture streams: every stream its process owns that
// does not read a monitor (system audio). Unrouted streams count, since they may be
// connected anywhere next.
function micStreams({pid,sources,outputs,clients}){
  const owned=ownedBy(pid,clients);
  const byIndex=new Map(sources.map(s=>[s.index,s]));
  return outputs.filter(o=>owned(o)&&!isMonitor(byIndex.get(o.source)));
}
// Mutes the recorder's microphone streams with a supported operation
// (pactl set-source-output-mute), then asks PipeWire again to confirm. Every step is
// bounded by queryMs. Returns
//   clear        the recorder has no microphone stream
//   muted        every microphone stream is confirmed muted (or gone)
//   unconfirmed  PipeWire did not answer, or a stream is still unmuted
// cancelled() is checked before each stage, so a round that is no longer wanted
// (the recorder exited, or the take's ending is draining its probes) starts nothing new.
async function muteTakeMic({pid,query,mute,queryMs=TIMING.queryMs,cancelled=()=>false}){
  const stop={state:'cancelled',muted:[],open:null};
  const read=async()=>{
    const [sources,outputs,clients]=await within(Promise.all([query.sources({timeout:queryMs}),query.sourceOutputs({timeout:queryMs}),query.clients({timeout:queryMs})]),queryMs);
    return micStreams({pid,sources,outputs,clients});
  };
  if(cancelled())return stop;
  let streams;
  try{streams=await read();}catch{return cancelled()?stop:{state:'unconfirmed',muted:[],open:null};}
  if(cancelled())return stop;
  if(!streams.length)return {state:'clear',muted:[],open:[]};
  const targets=streams.filter(o=>!o.mute).map(o=>o.index);
  await Promise.all(targets.map(i=>within(Promise.resolve().then(()=>mute(i)),queryMs).catch(()=>{})));
  if(cancelled())return stop;
  let after;
  try{after=await read();}catch{return cancelled()?stop:{state:'unconfirmed',muted:[],open:streams.map(o=>o.index)};}
  const open=after.filter(o=>!o.mute).map(o=>o.index);
  return {state:open.length?'unconfirmed':'muted',muted:targets.filter(i=>!open.includes(i)),open};
}


module.exports={SourceGuard,createPactl,evaluate,takePlan,faultMessage,withoutSaved,SAVED,pinEnv,micStreams,muteTakeMic,isMonitor,TIMING};
