'use strict';
// Live microphone indicator for the recording controls.
//
// What it measures: the recorder (GPU Screen Recorder) opens its own PipeWire capture
// stream on the microphone source it records. During a take this module finds that
// stream (owned by the recorder's process id), reads which source it is connected to,
// and reads the level of that same source with a small peak reader (parec), the same
// method the panel's meter uses before a take. So the level is the sound arriving at
// the exact source the recording is reading, after live cleanup when cleanup is on.
// It is not a reading of the encoded file. Nothing is stored or sent anywhere.
//
// It reports one of these states, so a failure never looks like a working microphone:
//   checking     a take just started and nothing is confirmed yet
//   live         the recorder's stream is connected and sound is arriving
//   quiet        connected and unmuted, but nothing above the quiet threshold lately
//   muted        the source or the recorder's stream is muted, or its volume is zero
//                (a zero stream volume is confirmed against the stream's own PipeWire
//                node first; see resolveZero)
//   held         the recorder's stream is corked (connected but not taking audio)
//   unlinked     the recorder has no microphone stream, or it is not connected
//   cleanup      live cleanup is on but its source has gone
//   unavailable  PipeWire or the level reader cannot be asked, so nothing is known, or
//                the recorder has more than one candidate stream that disagree
//   paused       the take is paused (the reader stops; nothing is being recorded)
//   none         the take has no microphone
// The reader and the checks run only while a take is recording, and stop on pause,
// stop, or when the controls close. Desktop audio is never measured: monitor sources
// are skipped, so system sound cannot show up as microphone level.
const {spawn:nodeSpawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

const CLEAN_SOURCE='vidcapture_mic';
const TIMING={statusMs:1500,queryMs:1200,tickMs:100,quietMs:1500,staleMs:1000,graceMs:500};
const KILL_WAIT_MS=250;
const MAX_PROPS_OUTPUT=4*1024*1024;
// Peaks below this count as quiet: about -50 dBFS, under normal room noise for a
// close microphone but well above digital silence.
const QUIET_DB=-50;

async function pactlJson(kind,timeout){
  const {stdout}=await run('pactl',['-f','json','list',kind],{timeout});
  return JSON.parse(stdout);
}
const PACTL={sources:o=>pactlJson('sources',o.timeout),sourceOutputs:o=>pactlJson('source-outputs',o.timeout),clients:o=>pactlJson('clients',o.timeout)};

function within(promise,ms){
  if(!(ms>0)){promise.catch?.(()=>{});return Promise.reject(new Error('timed out'));}
  let t;
  return Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error('timed out')),ms);})]).finally(()=>clearTimeout(t));
}
const props=x=>x?.properties||{};
const isMonitor=s=>!!s&&(String(s.name||'').endsWith('.monitor')||props(s)['device.class']==='monitor'||(s.monitor_of_sink!=null&&s.monitor_of_sink!==''&&s.monitor_of_sink!=='n/a'));
// True when every channel's volume is zero. pactl reports {channel:{value,...}}.
function silentVolume(v){
  if(!v||typeof v!=='object')return false;
  const values=Object.values(v).map(c=>Number(c?.value)).filter(Number.isFinite);
  return values.length>0&&values.every(x=>x===0);
}
// Running peak of a raw s16le stream. Chunks can split a sample, so a trailing odd
// byte is kept and joined with the next chunk instead of being dropped or misread.
function peakScanner(){
  let carry=null;
  return {peak:0,scan(buf){
    let b=buf;
    if(carry!==null){b=Buffer.concat([Buffer.from([carry]),buf]);carry=null;}
    const end=b.length-(b.length%2);
    for(let i=0;i<end;i+=2){const v=Math.abs(b.readInt16LE(i));if(v>this.peak)this.peak=v;}
    if(end<b.length)carry=b[end];
  },take(){const p=this.peak;this.peak=0;return p;}};
}
// Peak of 16-bit little endian samples as 0..1 on a -60 to 0 dB scale.
function peakLevel(peak){
  const p=peak/32768;const db=p>0?20*Math.log10(p):-60;
  return Math.max(0,Math.min(1,(db+60)/60));
}

// Works out what the recorder's microphone stream is doing from one PipeWire answer.
// pid is the recorder process; expect is the source name the take was started on
// (null when it follows the default input).
function readGraph({sources,outputs,clients,pid,expect}){
  const id=String(pid);
  const owners=new Set(clients.filter(c=>props(c)['application.process.id']===id).map(c=>String(props(c)['object.id'])).filter(x=>x!=='undefined'));
  const owned=o=>props(o)['application.process.id']===id||(props(o)['client.id']!=null&&owners.has(String(props(o)['client.id'])));
  const byIndex=new Map(sources.map(s=>[s.index,s]));
  const streams=outputs.filter(owned).map(o=>({o,source:byIndex.get(o.source)})).filter(x=>!isMonitor(x.source));
  if(expect===CLEAN_SOURCE&&!sources.some(s=>s.name===CLEAN_SOURCE))return {state:'cleanup'};
  // Every stream the recorder owns on the microphone it records. There is normally one.
  // More than one must agree on the source and on their state; otherwise which one is
  // the recorded track is not known, and nothing is claimed (no first match).
  const candidates=streams.filter(x=>x.source&&(!expect||x.source.name===expect));
  if(!candidates.length)return {state:'unlinked'};
  // A stream volume of zero is not proof on its own: pipewire-pulse reports a stream
  // whose PipeWire channel volumes were never set (empty arrays, which apply no
  // attenuation) as every channel at 0. Such a stream is 'zero', to be resolved
  // against its own node (resolveZero) before anything is claimed.
  const status=x=>x.o.corked===true?'held':(x.source.mute===true||x.o.mute===true||silentVolume(x.source.volume))?'muted':silentVolume(x.o.volume)?'zero':'ok';
  const names=new Set(candidates.map(x=>x.source.name)),states=new Set(candidates.map(status));
  if(names.size>1||states.size>1)return {state:'unavailable',reason:'ambiguous'};
  const [state]=states,[source]=names;
  if(state==='zero')return {state,source,nodes:candidates.map(x=>nodeIdentity(x.o,id))};
  return {state,source};
}

// What a stream's PipeWire node must match: its object id, serial (pipewire-pulse
// uses the serial as the stream index), client, name and the recorder's process id.
function nodeIdentity(o,pid){
  const p=props(o);
  return {id:p['object.id']??null,serial:p['object.serial']??null,index:o.index,client:p['client.id']??null,name:p['node.name']??null,pid};
}
const validIdentity=w=>!!w&&/^\d+$/.test(String(w.id??''))&&/^\d+$/.test(String(w.serial??''))&&String(w.serial)===String(w.index)&&w.client!=null&&String(w.client)!==''&&typeof w.name==='string'&&w.name!==''&&w.pid!=null;
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const gains=a=>Array.isArray(a)&&a.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);

// Decides a stream that pactl reports at zero volume from its own node, as pw-dump
// prints it. Returns 'ok' (no attenuation is set: positive volume, no channel or soft
// volumes, nothing muted), 'muted' (an actual mute, soft mute, zero volume or every
// channel or soft volume at zero), or 'unknown' when the node is not exactly this
// stream, its Props are missing or malformed, or they disagree with the zero report.
// Only this display decision uses it; the source guard's mute confirmation does not.
function resolveZero(dump,want){
  if(!Array.isArray(dump)||!want||want.id==null)return 'unknown';
  const nodes=dump.filter(n=>n&&same(n.id,want.id));
  if(nodes.length!==1)return 'unknown';
  const n=nodes[0],p=n.info?.props||{};
  if(n.type!=='PipeWire:Interface:Node'||!String(p['media.class']||'').startsWith('Stream/Input/Audio'))return 'unknown';
  if(!same(p['object.serial'],want.serial)||!same(want.serial,want.index)||!same(p['client.id'],want.client)||!same(p['application.process.id'],want.pid)||p['node.name']!==want.name)return 'unknown';
  const all=n.info?.params?.Props;
  // Exactly one Props entry, taken as a whole: an extra, partial or null entry is
  // never filtered away, since it may carry a conflicting mute or volume.
  if(!Array.isArray(all)||all.length!==1)return 'unknown';
  const v=all[0];
  if(!v||typeof v!=='object'||Array.isArray(v))return 'unknown';
  if(typeof v.mute!=='boolean'||typeof v.softMute!=='boolean'||typeof v.volume!=='number'||!Number.isFinite(v.volume)||v.volume<0||!gains(v.channelVolumes)||!gains(v.softVolumes))return 'unknown';
  if(v.mute||v.softMute||v.volume===0)return 'muted';
  const zero=a=>a.length>0&&a.every(x=>x===0);
  if(zero(v.channelVolumes)||zero(v.softVolumes))return 'muted';
  // Channel volumes that are set and not all zero contradict the zero report (the
  // stream changed between the two answers): nothing is claimed until the next check.
  if(v.channelVolumes.length)return 'unknown';
  return 'ok';
}

class TakeMeter{
  constructor({onUpdate,spawn=nodeSpawn,query=PACTL,timing={}}={}){
    this.onUpdate=onUpdate||(()=>{});this.spawn=spawn;this.query=query;this.timing={...TIMING,...timing};
    this.take=null;this.reader=null;this.poll=null;this.tick=null;this.generation=0;this.last=null;
    // Readers being stopped, until they have really exited.
    this.draining=new Map();
    // pw-dump processes started by checks, each killed at its deadline and on halt.
    this.probes=new Set();this.inflight=null;
  }
  // Brings the meter in line with the recorder. take is {pid,phase,expect,micNone}, or
  // null when nothing is recording or the controls are closed.
  sync(take){
    const live=take&&take.pid&&(take.phase==='recording'||take.phase==='paused');
    if(!live){this.stop();return;}
    if(!this.take||this.take.pid!==take.pid){this.stop();this.take={pid:take.pid,expect:take.expect||null,micNone:!!take.micNone};this.status=null;}
    const t=this.take;
    if(t.micNone){this.halt();this.emit({state:'none'});return;}
    if(take.phase==='paused'){this.halt();this.emit({state:'paused'});return;}
    if(this.poll)return;
    // Resuming, or a new take: nothing is confirmed until the next check answers.
    this.status=null;this.emit({state:'checking'});
    const gen=this.generation;
    const check=()=>{this.check(gen).catch(()=>{});};
    this.poll=setInterval(check,this.timing.statusMs);this.poll.unref?.();
    this.tick=setInterval(()=>this.sample(gen),this.timing.tickMs);this.tick.unref?.();
    check();
  }
  // One status check of the recorder's stream; results from an older take are dropped.
  async check(gen){
    const t=this.take;if(!t||gen!==this.generation)return;
    // One check at a time per take: a slow one is not overlapped by the next poll.
    if(this.inflight===gen)return;
    this.inflight=gen;
    try{await this.checkOnce(gen,t);}finally{if(this.inflight===gen)this.inflight=null;}
  }
  async graph(t){
    try{
      const ms=this.timing.queryMs;
      const [sources,outputs,clients]=await within(Promise.all([this.query.sources({timeout:ms}),this.query.sourceOutputs({timeout:ms}),this.query.clients({timeout:ms})]),ms);
      return readGraph({sources,outputs,clients,pid:t.pid,expect:t.expect});
    }catch{return {state:'unavailable'};}
  }
  async checkOnce(gen,t){
    let g=await this.graph(t);
    if(g.state==='zero'){
      if(gen!==this.generation||this.take!==t||!this.poll)return;
      const resolved=await this.resolve(g,gen);
      if(gen!==this.generation||this.take!==t||!this.poll)return;
      // The node answer is only about the stream as it was when asked. Ask the graph
      // again: the result stands only if the same streams are still the only reason
      // and still on the same source; any other fresh answer (mute, cork, a new route,
      // a lost stream) is reported as it is now, and a changed zero stream is unknown.
      if(resolved.state!=='unavailable'){
        const again=await this.graph(t);
        if(again.state!=='zero')g=again;
        else g=again.source===g.source&&JSON.stringify(again.nodes)===JSON.stringify(g.nodes)?resolved:{state:'unavailable',reason:'props'};
      }else g=resolved;
    }
    if(gen!==this.generation||this.take!==t||!this.poll)return;
    this.status={...g,at:Date.now()};
    if(g.state==='ok'){if(!this.reader||this.reader.source!==g.source)this.read(g.source,gen);}
    else this.stopReader();
    this.sample(gen);
  }
  // Confirms a zero stream volume against each stream's own node. Every node must
  // resolve, and agree, for a result; anything else is unavailable, never live or muted.
  async resolve(g,gen){
    const ms=this.timing.queryMs;
    // Without a complete identity there is nothing to match a node against: unknown,
    // and no query is started.
    if(!Array.isArray(g.nodes)||!g.nodes.length||!g.nodes.every(validIdentity))return {state:'unavailable',reason:'props'};
    try{
      // One node at a time, so at most one query process exists.
      const results=[];
      for(const want of g.nodes){
        if(gen!==this.generation)return {state:'unavailable',reason:'props'};
        results.push(resolveZero(await this.nodeDump(want.id,ms,gen),want));
      }
      const set=new Set(results);
      if(set.size!==1||set.has('unknown'))return {state:'unavailable',reason:'props'};
      return set.has('muted')?{state:'muted',source:g.source}:{state:'ok',source:g.source};
    }catch{return {state:'unavailable',reason:'props'};}
  }
  // One node's pw-dump, as a process this meter owns: SIGKILL at the deadline (it
  // cannot be ignored), killed at once on halt, and settled only when it has exited.
  // A test may supply query.props instead.
  nodeDump(id,ms,gen){
    if(typeof this.query.props==='function')return within(Promise.resolve(this.query.props(id,{timeout:ms})),ms);
    return new Promise((resolve,reject)=>{
      if(gen!==this.generation){reject(new Error('stale'));return;}
      // A query whose exit was never seen (from this take or an earlier one) is still
      // tracked; no new one starts until it is gone, so they cannot pile up.
      if(this.probes.size){reject(new Error('earlier query still running'));return;}
      let child;
      try{child=this.spawn('pw-dump',['-N',String(id)],{stdio:['ignore','pipe','ignore']});}catch(e){reject(e);return;}
      const probe={child,closed:false};probe.done=new Promise(r=>{probe.close=r;});
      this.probes.add(probe);
      let out='',failed=null;
      const kill=why=>{if(!failed)failed=why;try{child.kill('SIGKILL');}catch{}};
      probe.kill=()=>kill('stopped');
      const timer=setTimeout(()=>kill('timed out'),ms);
      child.stdout?.on('data',d=>{out+=d;if(out.length>MAX_PROPS_OUTPUT)kill('too large');});
      const end=(err)=>{
        if(probe.closed)return;probe.closed=true;clearTimeout(timer);this.probes.delete(probe);probe.close();
        if(err||failed)return reject(err||new Error(failed));
        try{resolve(JSON.parse(out));}catch(e){reject(e);}
      };
      // An error event is not proof the process is gone: one that started (has a pid)
      // is killed and stays tracked until its close is seen.
      child.once('error',e=>{if(child.pid==null)end(e);else{if(!failed)failed=e.message||'error';try{child.kill('SIGKILL');}catch{}}});
      child.once('close',(code,signal)=>end(code===0?null:new Error(`pw-dump ended with ${code??signal}`)));
    });
  }
  // Starts the peak reader on the source the recorder's stream reads.
  read(source,gen){
    this.stopReader();
    // At most one reader process at a time: while an earlier one has not been seen to
    // exit, no replacement starts. The state reads unavailable meanwhile (no reader),
    // and the next check after that exit starts the new reader.
    if(this.draining.size)return;
    let child;
    try{child=this.spawn('parec',['--device',source,'--format=s16le','--rate=16000','--channels=1','--latency-msec=50','--client-name=VidCapture level','--stream-name=Recording level'],{stdio:['ignore','pipe','ignore']});}
    catch{return;}
    const reader={source,child,scanner:peakScanner(),dataAt:0,sampledAt:0,loudAt:0,startedAt:Date.now()};this.reader=reader;
    child.on('error',()=>{if(this.reader===reader)this.stopReader();});
    child.on('exit',()=>{if(this.reader===reader)this.reader=null;});
    child.stdout?.on('data',buf=>{
      if(this.reader!==reader||gen!==this.generation)return;
      reader.dataAt=Date.now();reader.scanner.scan(buf);
    });
  }
  // Reports the current state and level. live or quiet need a recent good check and
  // a reader that is delivering data; anything less is reported as it is.
  sample(gen){
    if(gen!==this.generation||!this.take||!this.poll)return;
    const now=Date.now(),s=this.status,r=this.reader;
    if(!s){this.emit({state:'checking'});return;}
    if(s.state!=='ok'){this.emit({state:s.state});return;}
    if(now-s.at>this.timing.statusMs*2+this.timing.queryMs){this.emit({state:'unavailable'});return;}
    if(!r){this.emit({state:'unavailable'});return;}
    if(!r.dataAt){this.emit(now-r.startedAt>this.timing.staleMs?{state:'unavailable'}:{state:'checking'});return;}
    if(now-r.dataAt>this.timing.staleMs){this.emit({state:'unavailable'});return;}
    // No new samples since the last tick (chunks and ticks are not aligned): keep what
    // is shown. Freshness is checked above, so a stalled reader still turns unavailable.
    if(r.dataAt<=r.sampledAt)return;
    r.sampledAt=now;
    const level=peakLevel(r.scanner.take());
    if(level>(QUIET_DB+60)/60)r.loudAt=now;
    const loud=r.loudAt&&now-r.loudAt<=this.timing.quietMs;
    this.emit({state:loud?'live':'quiet',level:loud?level:0});
  }
  emit(m){
    const msg={state:m.state,level:Number.isFinite(m.level)?Math.round(m.level*100)/100:0};
    if(this.last&&this.last.state===msg.state&&this.last.level===msg.level)return;
    this.last=msg;this.onUpdate(msg);
  }
  // Stops checks and the reader but keeps the take (pause).
  halt(){
    this.generation++;
    if(this.poll)clearInterval(this.poll);if(this.tick)clearInterval(this.tick);this.poll=null;this.tick=null;
    this.stopReader();this.status=null;
    for(const p of this.probes)p.kill();
  }
  // Detaches the reader at once (no more updates from it) and ends its process:
  // SIGTERM, then SIGKILL after graceMs. Resolves within graceMs plus KILL_WAIT_MS with
  // {pid,exited}: exited is true only when the process really reported its exit. When
  // it did not, the outcome is unconfirmed and the process stays tracked in draining
  // until it does exit, so nothing claims an exit that was never seen.
  stopReader(){const r=this.reader;this.reader=null;if(r)this.terminate(r.child);}
  terminate(child){
    if(!child)return Promise.resolve({pid:null,exited:true});
    if(child.exitCode!=null||child.signalCode)return Promise.resolve({pid:child.pid,exited:true});
    const known=this.draining.get(child);if(known)return known.outcome;
    const entry={child,exited:false};
    const exit=new Promise(resolve=>child.once('exit',()=>{
      entry.exited=true;this.draining.delete(child);resolve();
      // The last stopping reader is gone: check again now so a waiting replacement starts.
      if(!this.draining.size&&this.poll&&this.take)this.check(this.generation).catch(()=>{});
    }));
    entry.outcome=new Promise(resolve=>{
      let soft,hard;
      exit.then(()=>{clearTimeout(soft);clearTimeout(hard);resolve({pid:child.pid,exited:true});});
      soft=setTimeout(()=>{
        try{child.kill('SIGKILL');}catch{}
        hard=setTimeout(()=>resolve({pid:child.pid,exited:entry.exited}),KILL_WAIT_MS);
      },this.timing.graceMs);
      try{child.kill('SIGTERM');}catch{}
    });
    this.draining.set(child,entry);
    return entry.outcome;
  }
  // Waits, bounded, for every reader this meter is stopping. Resolves to
  // {unconfirmed:[pids]}: the readers whose exit was not seen in time (still tracked).
  // Node queries still running are killed and waited for in the same bound.
  drain(){
    const probes=[...this.probes];
    for(const p of probes)p.kill();
    const probeWait=Promise.all(probes.map(p=>Promise.race([p.done.then(()=>null),new Promise(r=>setTimeout(()=>r(p.child.pid),this.timing.graceMs+KILL_WAIT_MS))])));
    return Promise.all([Promise.all([...this.draining.values()].map(e=>e.outcome)),probeWait])
      .then(([rs,ps])=>({unconfirmed:[...rs.filter(r=>!r.exited).map(r=>r.pid),...ps.filter(x=>x!=null)]}));
  }
  // Ends everything for this take. Nothing is sent after this.
  stop(){this.halt();this.take=null;this.last=null;}
  snapshot(){return this.last||{state:'checking',level:0};}
}

module.exports={TakeMeter,readGraph,resolveZero,peakLevel,peakScanner,isMonitor,TIMING,QUIET_DB,CLEAN_SOURCE};
