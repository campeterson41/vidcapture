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

async function sources(){
  const {stdout}=await run('pactl',['-f','json','list','sources'],{timeout:4000});
  return JSON.parse(stdout);
}

class AudioChain{
  constructor(dataDir,options={}){
    this.dataDir=dataDir;this.child=null;this.key=null;this.starting=null;
    this.pipewire=options.pipewire||'pipewire';this.plugin=options.plugin||null;
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
  // or null when no cleanup is on.
  async ensure(settings){
    if(!wanted(settings)){await this.stop();return null;}
    const run=async()=>{
      const mic=await this.resolveMic(settings.microphone);
      const plugin=settings.micNoise==='on'?await this.findPlugin():null;
      if(settings.micNoise==='on'&&!plugin)throw new Error('Noise removal needs the RNNoise plugin. Install the noise-suppression-for-voice package.');
      const options={mic,noise:settings.micNoise==='on',gate:settings.micGate||'off',rumble:settings.micRumble===true,plugin};
      const key=JSON.stringify(options);
      if(this.child&&this.key===key&&this.child.exitCode===null)return SOURCE;
      await this.stop();
      const file=path.join(this.dataDir,'microphone-chain.conf');
      await fs.writeFile(file,chainConfig(options),{mode:0o600});
      const child=spawn(this.pipewire,['-c',file],{stdio:['ignore','ignore','pipe']});
      let err='';child.stderr.on('data',b=>{err=(err+b).slice(-2000);});
      this.child=child;this.key=key;
      child.once('exit',()=>{if(this.child===child){this.child=null;this.key=null;}});
      for(let i=0;i<40;i++){
        if(child.exitCode!==null)throw new Error(`Microphone cleanup could not start. ${err.trim().split('\n').pop()||''}`.trim());
        if((await sources().catch(()=>[])).some(s=>s.name===SOURCE))return SOURCE;
        await new Promise(r=>setTimeout(r,100));
      }
      await this.stop();throw new Error('Microphone cleanup did not start in time.');
    };
    this.starting=(this.starting||Promise.resolve()).then(run,run);
    return this.starting;
  }
  async stop(){
    const child=this.child;this.child=null;this.key=null;
    if(!child||child.exitCode!==null)return;
    await new Promise(resolve=>{const t=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},1500);child.once('exit',()=>{clearTimeout(t);resolve();});child.kill('SIGTERM');});
  }
  running(){return !!(this.child&&this.child.exitCode===null);}
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

module.exports={AudioChain,chainConfig,wanted,SOURCE,GATES};
