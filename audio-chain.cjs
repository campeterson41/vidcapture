'use strict';
// Live microphone cleanup. When any cleanup option is on, VidCapture runs a
// small PipeWire filter-chain client that reads the chosen microphone and offers
// a virtual source, "VidCapture microphone", for the recorder. The chain is:
// rumble filter (80 Hz high-pass), RNNoise noise removal, and a voice gate that
// uses RNNoise's speech detection to silence the gaps between words. The raw
// microphone can be recorded beside it as an untouched backup track.
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);

const SOURCE='vidcapture_mic';
const GATES={off:0,gentle:60,strong:90};
const RNNOISE=['/usr/lib/ladspa/librnnoise_ladspa.so','/usr/lib64/ladspa/librnnoise_ladspa.so','/usr/local/lib/ladspa/librnnoise_ladspa.so'];

const wanted=s=>!!(s&&s.microphone!=='none'&&(s.micNoise==='on'||s.micRumble===true));
const quote=v=>'"'+String(v).replace(/["\\]/g,'')+'"';

// The filter-chain config for one microphone and set of options.
function chainConfig({mic,noise,gate,rumble,plugin}){
  const nodes=[],links=[];let first=null,last=null;
  const add=(node,input,output)=>{nodes.push(node);if(last)links.push(`{ output = ${quote(last)} input = ${quote(input)} }`);if(!first)first=input;last=output;};
  if(rumble)add('{ type = builtin name = rumble label = bq_highpass control = { "Freq" = 80.0 "Q" = 0.707 } }','rumble:In','rumble:Out');
  if(noise)add(`{ type = ladspa name = clean plugin = ${quote(plugin)} label = noise_suppressor_mono control = { "VAD Threshold (%)" = ${GATES[gate]??0}.0 "VAD Grace Period (ms)" = 240 "Retroactive VAD Grace (ms)" = 0 } }`,'clean:Input','clean:Output');
  if(!nodes.length)throw new Error('No microphone cleanup is turned on.');
  return `context.properties = { log.level = 0 }
context.spa-libs = {
  audio.convert.* = audioconvert/libspa-audioconvert
  support.* = support/libspa-support
}
context.modules = [
  { name = libpipewire-module-rt args = {} flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-filter-chain
    args = {
      node.description = "VidCapture microphone"
      media.name = "VidCapture microphone"
      audio.rate = 48000
      filter.graph = {
        nodes = [
          ${nodes.join('\n          ')}
        ]
        links = [ ${links.join(' ')} ]
        inputs = [ ${quote(first)} ]
        outputs = [ ${quote(last)} ]
      }
      capture.props = { node.name = "${SOURCE}.input" target.object = ${quote(mic)} audio.position = [ MONO ] stream.dont-remix = true node.passive = true node.dont-reconnect = true }
      playback.props = { node.name = "${SOURCE}" node.description = "VidCapture microphone" media.class = Audio/Source audio.position = [ MONO ] }
    }
  }
]
`;
}

// Timing. Every PipeWire question has its own short timeout, and each ensure has one
// wall-clock deadline that covers everything it waits on: finding the microphone,
// stopping an old chain, each start attempt, and every graph check. A hung pactl or a
// slow PipeWire therefore holds up the caller for at most ensureMs, plus up to 0.25 s
// for a process that was force-stopped at the deadline to exit.
const TIMING={ensureMs:10000,startMs:4500,verifyMs:1500,queryMs:2000,pollMs:100,graceMs:1500};
const START_ATTEMPTS=2,KILL_WAIT_MS=250;
async function pactlJson(kind,timeout){
  const {stdout}=await run('pactl',['-f','json','list',kind],{timeout});
  return JSON.parse(stdout);
}
const PACTL={sources:o=>pactlJson('sources',o.timeout),sourceOutputs:o=>pactlJson('source-outputs',o.timeout),clients:o=>pactlJson('clients',o.timeout)};
const sleep=ms=>new Promise(r=>setTimeout(r,Math.max(0,ms)));
// Waits for a promise for at most ms. The losing promise keeps a handler, so a late
// rejection is not reported as unhandled.
function within(promise,ms,what){
  if(!(ms>0)){promise.catch?.(()=>{});return Promise.reject(new Error(`${what} timed out.`));}
  let t;
  return Promise.race([promise,new Promise((_,reject)=>{t=setTimeout(()=>reject(new Error(`${what} timed out.`)),ms);})]).finally(()=>clearTimeout(t));
}
// A newer change (cleanup turned off, the app quitting) took over this ensure.
const canceled=()=>Object.assign(new Error('Microphone cleanup changed before it finished starting.'),{canceled:true});
// PipeWire could not be asked, so the chain is neither confirmed nor known to be broken.
const unknown=()=>Object.assign(new Error('Could not check the microphone cleanup. Try again in a moment.'),{unknown:true});

class AudioChain{
  constructor(dataDir,options={}){
    this.dataDir=dataDir;this.child=null;this.key=null;this.mic=null;this.starting=null;
    // Last known health, for display only (the level meter). Nothing that hands out the
    // cleaned source trusts it: ensure always asks PipeWire again.
    this.healthy=false;
    // Bumped by stop(), including turning cleanup off. An ensure that started under an
    // older generation gives up instead of starting a chain nobody wants any more.
    this.generation=0;
    this.pipewire=options.pipewire||'pipewire';this.plugin=options.plugin||null;
    this.query=options.query||PACTL;
    this.timing={...TIMING,...(options.pollMs!=null?{pollMs:options.pollMs}:{}),...(options.timing||{})};
  }
  async findPlugin(){
    if(this.plugin)return this.plugin;
    for(const p of RNNOISE){try{await fs.access(p);this.plugin=p;return p;}catch{}}
    return null;
  }
  // Whether noise removal can run here; the rumble filter is built into PipeWire.
  async available(){return {noise:!!(await this.findPlugin())};}
  async resolveMic(setting){
    if(setting!=='default_input')return setting;
    const {stdout}=await run('pactl',['get-default-source'],{timeout:4000});
    const name=stdout.trim();
    if(!name||name===SOURCE)throw new Error('Choose a microphone for cleanup.');
    return name;
  }
  // Starts or updates the chain for these settings and returns the source to record,
  // or null when no cleanup is on. Settles within timing.ensureMs of the call (see TIMING).
  async ensure(settings){
    if(!wanted(settings)){await this.stop();return null;}
    const generation=this.generation,deadline=Date.now()+this.timing.ensureMs;
    const run=async()=>{
      const live=()=>{if(this.generation!==generation)throw canceled();};
      // Each wait is checked against the generation afterwards, so a stop or a disable
      // that happened meanwhile wins.
      const step=async p=>{try{const v=await p;live();return v;}catch(e){live();throw e;}};
      live();
      const mic=await step(within(this.resolveMic(settings.microphone),deadline-Date.now(),'Finding the microphone'));
      const plugin=settings.micNoise==='on'?await step(this.findPlugin()):null;
      if(settings.micNoise==='on'&&!plugin)throw new Error('Noise removal needs the RNNoise plugin. Install the noise-suppression-for-voice package.');
      const options={mic,noise:settings.micNoise==='on',gate:settings.micGate||'off',rumble:settings.micRumble===true,plugin};
      const key=JSON.stringify(options);
      // Reuse a running chain only while its own graph is really there. A process can
      // stay alive after its microphone fails and PipeWire removes its nodes. Only a
      // fresh, confirmed answer counts; the last known health does not. If PipeWire
      // cannot be asked, keep the chain (it may be fine, and an idle chain is never
      // restarted on a guess) but refuse to hand back an unverified source.
      if(this.child&&this.key===key&&this.child.exitCode===null){
        const h=await step(this.verify(key,Math.min(deadline,Date.now()+this.timing.verifyMs)));
        if(h.ok===true)return SOURCE;
        if(h.ok===null&&this.child&&this.child.exitCode===null&&this.key===key)throw unknown();
      }
      let last=null;
      for(let attempt=0;attempt<START_ATTEMPTS&&Date.now()<deadline;attempt++){
        try{return await this.start(options,key,{generation,deadline:Math.min(deadline,Date.now()+this.timing.startMs)});}
        catch(e){last=e;if(e.fatal||e.canceled)break;}
      }
      live();
      throw last||new Error('Microphone cleanup did not start in time.');
    };
    this.starting=(this.starting||Promise.resolve()).then(run,run);
    return this.starting;
  }
  // Asks PipeWire about the running chain until it gets a real answer or until is reached.
  async verify(key,until){
    let h=await this.health({until});
    while(h.ok===null&&Date.now()+this.timing.pollMs<until){
      await sleep(this.timing.pollMs);
      if(!this.child||this.child.exitCode!==null||this.key!==key)break;
      h=await this.health({until});
    }
    return h;
  }
  // Starts the chain and waits, until the deadline, for its own source and capture input.
  async start(options,key,{generation=this.generation,deadline=Date.now()+this.timing.startMs}={}){
    const live=()=>this.generation===generation;
    await this.kill(this.graceLeft(deadline));
    if(!live())throw canceled();
    const file=path.join(this.dataDir,'microphone-chain.conf');
    await fs.writeFile(file,chainConfig(options),{mode:0o600});
    // Checked right before spawning, with no wait in between, so a stop that came in
    // while the file was written never leaves a new chain behind.
    if(!live())throw canceled();
    const child=spawn(this.pipewire,['-c',file],{stdio:['ignore','ignore','pipe']});
    let err='';child.stderr?.on('data',b=>{err=(err+b).slice(-2000);});
    child.on?.('error',e=>{err=(err+e.message).slice(-2000);});
    this.child=child;this.key=key;this.mic=options.mic;this.healthy=false;
    child.once('exit',()=>{if(this.child===child){this.child=null;this.key=null;this.healthy=false;}});
    let h={ok:null};
    for(;;){
      if(child.exitCode!==null)throw Object.assign(new Error(`Microphone cleanup could not start. ${err.trim().split('\n').pop()||''}`.trim()),{fatal:true});
      if(Date.now()>=deadline)break;
      h=await this.health({until:deadline});
      if(!live()){if(this.child===child)await this.kill(0);throw canceled();}
      if(h.ok===true)return SOURCE;
      await sleep(Math.min(this.timing.pollMs,deadline-Date.now()));
    }
    if(this.child===child)await this.kill(this.graceLeft(deadline));
    if(h.reason==='unlinked'||h.reason==='no-input')throw new Error('Microphone cleanup could not connect to the microphone. Check that it is plugged in.');
    throw new Error('Microphone cleanup did not start in time.');
  }
  // Whether the running chain's own PipeWire graph is in place: a cleaned source and a
  // capture stream that belong to this chain's process, with the stream reading the
  // chosen microphone. Ownership goes through PipeWire's client list: a node's
  // client.id names its client by PipeWire object id, which pactl reports as the
  // client's object.id property (its pactl index is a different number), and the
  // chain's client carries the process id. A node
  // that only shares the name (another app, or another copy of VidCapture) does not
  // count. This looks only at the graph, never at sound, so a quiet room is not a
  // failure. ok is null when PipeWire cannot be asked in time; that never changes the
  // last known health, and never triggers a restart by itself.
  async health({until}={}){
    const child=this.child;
    if(!child||child.exitCode!==null){this.healthy=false;return {ok:false,reason:'stopped'};}
    const ms=Math.floor(Math.min(this.timing.queryMs,(until??Infinity)-Date.now()));
    if(!(ms>0))return {ok:null,reason:'unknown'};
    let list,outputs,clients;
    try{[list,outputs,clients]=await within(Promise.all([this.query.sources({timeout:ms}),this.query.sourceOutputs({timeout:ms}),this.query.clients({timeout:ms})]),ms,'Checking the microphone cleanup');}
    catch{return {ok:null,reason:'unknown'};}
    if(this.child!==child)return {ok:false,reason:'stopped'};
    const pid=String(child.pid),props=x=>x?.properties||{};
    const owners=new Set(clients.filter(c=>props(c)['pipewire.sec.pid']===pid||props(c)['application.process.id']===pid).map(c=>String(props(c)['object.id'])).filter(id=>id!=='undefined'));
    const owned=n=>props(n)['client.id']!=null&&owners.has(String(props(n)['client.id']));
    const source=list.some(x=>x.name===SOURCE&&owned(x));
    const input=outputs.find(o=>props(o)['node.name']===`${SOURCE}.input`&&owned(o));
    let result;
    if(!source&&!input)result={ok:false,reason:'missing'};
    else if(!input)result={ok:false,reason:'no-input'};
    else if(!source)result={ok:false,reason:'missing'};
    else{
      const from=list.find(x=>x.index===input.source);
      result=from&&(!this.mic||from.name===this.mic)?{ok:true}:{ok:false,reason:'unlinked'};
    }
    this.healthy=result.ok===true;
    return result;
  }
  graceLeft(deadline){return Math.max(0,Math.min(this.timing.graceMs,deadline-Date.now()));}
  // Stops the chain, and makes any ensure still in progress give up without starting one.
  async stop(){this.generation++;await this.kill();}
  // Ends the current process: SIGTERM, then SIGKILL after grace ms (at once when grace is 0).
  async kill(grace=this.timing.graceMs){
    const child=this.child;this.child=null;this.key=null;this.healthy=false;
    if(!child||child.exitCode!==null)return;
    await new Promise(resolve=>{
      let t;const done=()=>{clearTimeout(t);resolve();};child.once('exit',done);
      const hard=()=>{try{child.kill('SIGKILL');}catch{}t=setTimeout(done,KILL_WAIT_MS);};
      if(grace>0){t=setTimeout(hard,grace);try{child.kill('SIGTERM');}catch{}}else hard();
    });
  }
  // Running means the process is alive and its graph was last seen in place. This is
  // last known health for display; ensure never relies on it.
  running(){return !!(this.child&&this.child.exitCode===null&&this.healthy);}
  // The microphone's own input level, in percent, through PipeWire.
  async level(setting){
    const mic=await this.resolveMic(setting);
    const {stdout}=await run('pactl',['get-source-volume',mic],{timeout:4000});
    const m=stdout.match(/(\d+)%/);return {source:mic,percent:m?Number(m[1]):null};
  }
  async setLevel(setting,percent){
    const p=Number(percent);if(!Number.isInteger(p)||p<0||p>150)throw new Error('Mic level must be between 0 and 150 percent.');
    const mic=await this.resolveMic(setting);
    await run('pactl',['set-source-volume',mic,`${p}%`],{timeout:4000});
    return this.level(setting);
  }
}

// Checks a running chain between takes, every few seconds. When its graph has gone,
// it asks for one recovery; it tries again only after the chain is seen healthy, so a
// microphone that stays broken never causes a restart loop. Nothing runs during a take,
// and nothing new starts once the watch is stopped.
class ChainWatch{
  constructor({chain,isBusy,recover,interval=5000}){this.chain=chain;this.isBusy=isBusy;this.recover=recover;this.interval=interval;this.timer=null;this.current=null;this.stopped=false;this.tried=false;}
  start(){if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>{this.tick().catch(()=>{});},this.interval);this.timer.unref?.();}
  // Stops the timer and returns once a check in progress has finished. A check that
  // was waiting on PipeWire when the watch stopped does not go on to recover.
  async stop(){
    this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;
    await this.current?.catch(()=>{});
  }
  tick(){
    if(this.stopped||this.current||this.isBusy()||!this.chain.child)return Promise.resolve('idle');
    const work=(async()=>{
      await null;// this.current is set before any of the check runs
      try{
        const h=await this.chain.health();
        if(this.stopped)return 'stopped';
        if(h.ok===true){this.tried=false;return 'healthy';}
        if(h.ok===null||this.isBusy())return 'unknown';
        if(this.tried)return 'waiting';
        this.tried=true;await this.recover(h);return 'recovering';
      }finally{if(this.current===work)this.current=null;}
    })();
    this.current=work;
    return work;
  }
}

// Brings the chain in line with the settings between takes and records the outcome in
// the recorder state (micCleanupError), where the panel and main window read it.
// An ensure that a newer change took over records nothing; the newer one reports.
// An unanswered check is not news about a known failure, so the more specific known
// message stays; it never clears an error either, since nothing was confirmed.
async function syncCleanup({chain,recorder,isBusy}){
  if(isBusy())return undefined;
  let error=null;
  try{await chain.ensure(recorder.state.settings);}
  catch(e){
    if(e.canceled)return undefined;
    error=e.unknown&&recorder.state.micCleanupError?recorder.state.micCleanupError:e.message;
  }
  if((recorder.state.micCleanupError||null)!==error)recorder.set({micCleanupError:error});
  return error;
}

module.exports={AudioChain,ChainWatch,syncCleanup,chainConfig,wanted,SOURCE,GATES,TIMING};
