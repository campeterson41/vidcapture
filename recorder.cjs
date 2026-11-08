const {EventEmitter} = require('node:events');
const {displayName,deviceLabel}=require('./names.cjs');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs/promises');
const {watch,constants:fsConstants} = require('node:fs');
const {versionBase}=require('./library.cjs');
const {validImageName}=require('./camera-effects.cjs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {cameraMode,cameraRecordMode,cameraShader,cameraCommand}=require('./camera.cjs');
const {cameraKey}=require('./camera-settings.cjs');
const {publicProfile}=require('./camera-profiles.cjs');
const {selectedWindow,windowTarget,matchingWindow,containingMonitor,physicalRegion}=require('./tracking.cjs');
const {SourceGuard,createPactl,takePlan,faultMessage,withoutSaved,pinEnv,muteTakeMic}=require('./source-guard.cjs');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ACTIVE = new Set(['selecting','starting','recording','paused','stopping']);
// Any finished video in the recordings folder; partial saves and hidden work
// folders are skipped.
function isRecordingName(name){return typeof name==='string'&&!name.startsWith('.')&&/\.(mp4|mkv)$/i.test(name)&&!name.endsWith('.saving.mp4');}

// The raw file a take writes: Capture-<timestamp>.mkv directly in the recordings folder.
function takeFile(file,outputDir){
  return typeof file==='string'&&path.dirname(file)===outputDir&&/^Capture-[0-9TZ-]+\.mkv$/.test(path.basename(file));
}

const DEFAULTS = {microphone:'default_input',systemAudio:false,camera:'none',cameraSize:'small',cameraCorner:'bottom-right',cameraCorrection:'computer',cameraLighting:'original',fps:30,quality:'high',resolution:'1920x1080',countdown:3,micNoise:'off',micGate:'off',micRumble:false,micBackup:true,cameraBackground:'off',cameraBlur:'medium',cameraBackgroundImage:''};

function validateSettings(input, current, devices) {
  const s = {...current};
  const allowed = {
    microphone:['none','default_input',...devices.microphones.map(d=>d.id)],
    camera:['none',...devices.cameras.map(d=>d.id)],
    cameraSize:['small','medium','large'], cameraCorner:['bottom-right','bottom-left'],
    cameraCorrection:['computer','off'],cameraLighting:['original','balanced'],
    fps:[30,60],quality:['high','very_high','ultra'],resolution:['1920x1080','0x0'],systemAudio:[true,false],countdown:[0,3],
    micNoise:['off','on'],micGate:['off','gentle','strong'],micRumble:[true,false],micBackup:[true,false],
    cameraBackground:['off','blur','image'],cameraBlur:['light','medium','strong']
  };
  for (const [k,v] of Object.entries(input)) {
    // A background image is a file name inside VidCapture's backgrounds folder.
    if (k==='cameraBackgroundImage') {if(v!==''&&!validImageName(v))throw new Error(`Invalid setting: ${k}`);s[k]=v;continue;}
    if (!allowed[k] || !allowed[k].includes(v)) throw new Error(`Invalid setting: ${k}`);
    s[k]=v;
  }
  return s;
}

function parseRegion(text) {
  const m = text.trim().match(/^(-?\d+),(-?\d+)\s+(\d+)x(\d+)$/);
  if (!m || +m[3]<32 || +m[4]<32) throw new Error('Choose an area at least 32 pixels wide and tall.');
  return {kind:'region',x:+m[1],y:+m[2],width:+m[3],height:+m[4],label:`Selected area (${m[3]} × ${m[4]})`};
}

// clean is the live cleanup source (audio-chain.cjs) when it is on; the raw
// microphone is then added as a final backup track if micBackup is set. micName is
// the take's resolved microphone source: Default is resolved once when a take starts,
// so losing it can never hand the take to whichever input becomes the default next.
function buildArgs(target, settings, output, clean=null, micName=null) {
  let args;
  if(target.kind==='camera'){
    // Camera only: GPU Screen Recorder reads the camera itself, full frame.
    const m=target.mode||{};
    if(!/^\/dev\/video\d+$/.test(String(target.device)))throw new Error('Choose a camera first.');
    const opts=m.width&&m.height?`;camera_width=${m.width};camera_height=${m.height};camera_fps=${m.fps||30};pixfmt=${m.pixfmt||'auto'}`:'';
    args=['-w',target.device+opts,'-s',m.width&&m.height?`${m.width}x${m.height}`:settings.resolution,'-k','h264','-f',String(m.fps||30)];
  }else{
    args = target.kind==='monitor' ? ['-w',target.monitor] : ['-w',`${target.width}x${target.height}+${target.x}+${target.y}`];
    args.push('-s',settings.resolution,'-k','h264','-f',String(settings.fps));
  }
  args.push('-fm','vfr','-q',settings.quality,'-fallback-cpu-encoding','yes','-o',output);
  const audio=[];
  if(settings.systemAudio) audio.push('default_output');
  const raw=micName?`device:${micName}`:settings.microphone==='default_input'?'default_input':`device:${settings.microphone}`;
  const mic=clean?`device:${clean}`:raw;
  if(settings.microphone!=='none') audio.push(mic);
  if(audio.length) args.push('-a',audio.join('|'),'-ac','aac');
  // Keep isolated tracks as well as the default listening mix for Folio.
  if(settings.systemAudio && settings.microphone!=='none')args.push('-a',mic,'-a','default_output');
  if(clean&&settings.microphone!=='none'&&settings.micBackup)args.push('-a',raw);
  return args;
}

const faultInfo=f=>({reason:f.fault,source:f.source||null,to:f.to||null,at:new Date(f.at||Date.now()).toISOString()});

function cameraGeometry(target, size, corner, placement=null) {
  const margin=16;
  const diameter=Math.max(32,Math.min(Math.max({small:72,medium:112,large:160}[size],Math.min(720,Math.round(Math.min(target.width,target.height)*{small:0.22,medium:0.34,large:0.48}[size]))),target.width-margin*2,target.height-margin*2));
  const x=placement?margin+Math.max(0,target.width-diameter-margin*2)*Math.max(0,Math.min(1,placement.x)):(corner==='bottom-left'?margin:target.width-diameter-margin);
  const y=placement?margin+Math.max(0,target.height-diameter-margin*2)*Math.max(0,Math.min(1,placement.y)):target.height-diameter-margin;
  return {size:diameter,x:Math.round(target.x+x),y:Math.round(target.y+y)};
}

class Recorder extends EventEmitter {
  constructor(options={}) {
    super();
    this.dataDir=options.dataDir||path.join(os.homedir(),'.local/state/capture');
    // Optional services: live microphone cleanup and saved camera controls.
    this.audioChain=options.audioChain||null;this.cameraSettings=options.cameraSettings||null;this.cameraEffects=options.cameraEffects||null;
    // Optional per-model tuning (camera-profiles.cjs).
    this.cameraProfiles=options.cameraProfiles||null;this.cameraKeys=new Map();
    // A fixed folder (tests) cannot be changed from the app.
    this.fixedOutput=!!options.outputDir;
    this.outputDir=options.outputDir||path.join(os.homedir(),'Videos/Capture');
    this.state={phase:'idle',elapsed:0,target:null,settings:{...DEFAULTS},devices:{microphones:[],cameras:[],monitors:[]},outputDir:this.outputDir,recent:[],lastFile:null,error:null,micCleanupError:null,cameraPreview:false};
    this.child=null;this.camera=null;this.started=0;this.pausedAt=0;this.pauseTotal=0;this.rawFile=null;this.log='';this.finalizing=null;
    this.beforePick=options.beforePick||(()=>{});this.afterPick=options.afterPick||(()=>{});
    // The microphone route guard (source-guard.cjs). Its PipeWire query, timing and
    // the default-input lookup can be replaced in tests.
    this.sourceGuard=null;this.faulting=null;this.interrupted=null;this.micFaultInfo=null;
    this.followEngine=options.followEngine||null;
    this.guardQuery=options.guardQuery||undefined;this.guardTiming=options.guardTiming||{};
    // A faulted take whose microphone is confirmed muted gets faultStopMs to save
    // normally; one that cannot be confirmed gets only faultUnsafeMs before it is killed.
    this.faultStopMs=options.faultStopMs??10000;this.faultUnsafeMs=options.faultUnsafeMs??1500;this.faultKillMs=options.faultKillMs??3000;
    this.defaultSource=options.defaultSource||(async()=>(await run('pactl',['get-default-source'],{timeout:4000})).stdout.trim());
    // pactl probes the recorder owns for ending a faulted take (killed and reaped after).
    this.pactl=options.pactl||createPactl();
    this.muteStream=options.muteStream||(index=>this.pactl.mute(index,this.guardTiming.queryMs));
    this.cameraPlacement=null;this.lastCameraGeometry=null;
    this.followSequence=0;this.followFile=path.join(this.dataDir,'follow-state');
    this.followTimer=setInterval(()=>{if(this.state.target?.kind==='window')this.updateWindow().catch(e=>this.set({error:e.message}));else if(this.camera&&!this.cameraUpdate)this.cameraUpdate=this.positionCamera(false).catch(e=>this.set({error:e.message})).finally(()=>{this.cameraUpdate=null;});},30);this.followTimer.unref();
    this.timer=setInterval(()=>this.publish(),1000);this.timer.unref();
  }
  snapshot() {
    if(this.started && ['recording','paused','stopping'].includes(this.state.phase)) this.state.elapsed=Math.max(0,((this.pausedAt||Date.now())-this.started-this.pauseTotal)/1000);
    return structuredClone(this.state);
  }
  publish() {this.emit('state',this.snapshot());return this.snapshot();}
  set(data) {Object.assign(this.state,data);return this.publish();}
  idleOnly() {if(ACTIVE.has(this.state.phase)) throw new Error('Stop and save this recording before changing its settings.');if(this.child&&this.child.exitCode===null&&!this.child.signalCode)throw new Error(`The previous recorder (process ${this.child.pid}) has not exited yet. Wait for it to stop.`);if(this.state.job?.running)throw new Error('Wait for processing to finish, or cancel it first.');}
  async init() {
    await fs.mkdir(this.dataDir,{recursive:true,mode:0o700});
    if(!this.fixedOutput){
      try{const saved=JSON.parse(await fs.readFile(path.join(this.dataDir,'location.json'),'utf8'));if(typeof saved.outputDir==='string'&&path.isAbsolute(saved.outputDir))this.outputDir=saved.outputDir;}catch{}
      this.state.outputDir=this.outputDir;
    }
    await fs.mkdir(this.outputDir,{recursive:true,mode:0o700});
    await this.refreshDevices();
    try {const saved=JSON.parse(await fs.readFile(path.join(this.dataDir,'settings.json'),'utf8'));for(const [k,v] of Object.entries(saved)){try{this.state.settings=validateSettings({[k]:v},this.state.settings,this.state.devices);}catch{}}}catch{}
    await this.refreshRecent();
    this.deviceWatcher=watch('/dev',(_event,name)=>{
      if(!/^video\d+$/.test(String(name)))return;
      clearTimeout(this.deviceRefreshTimer);
      this.deviceRefreshTimer=setTimeout(()=>this.refreshDevices().catch(()=>{}),300);
      this.deviceRefreshTimer.unref();
    });
    return this.publish();
  }
  refreshDevices() {
    if(this.deviceRefreshPromise)return this.deviceRefreshPromise;
    this.deviceRefreshPromise=this.enumerateDevices().finally(()=>{this.deviceRefreshPromise=null;});
    return this.deviceRefreshPromise;
  }
  async enumerateDevices() {
    const results=await Promise.allSettled([
      run('pactl',['-f','json','list','sources'],{timeout:5000}),
      run('hyprctl',['monitors','-j'],{timeout:5000}),
      run('v4l2-ctl',['--list-devices'],{timeout:5000})
    ]);
    const sources=results[0].status==='fulfilled'?JSON.parse(results[0].value.stdout):[];
    const monitors=results[1].status==='fulfilled'?JSON.parse(results[1].value.stdout):[];
    const cameras=[];
    const files=(await fs.readdir('/dev')).filter(n=>/^video\d+$/.test(n));
    for(const file of files) {
      try {
        const device=`/dev/${file}`;
        const {stdout}=await run('v4l2-ctl',['-d',device,'--list-formats'],{timeout:2000});
        if(!/MJPG|YUYV|NV12|RGB3/.test(stdout)) continue;
        const {stdout:info}=await run('v4l2-ctl',['-d',device,'--info'],{timeout:2000});
        const name=info.match(/Card type\s*:\s*(.+)/)?.[1]?.trim()||file;
        if(cameras.some(c=>c.name===deviceLabel(name))) continue;
        const camera={id:device,name:deviceLabel(name)};
        if(this.cameraProfiles){
          const key=await cameraKey(device).catch(()=>null);
          if(key)this.cameraKeys.set(device,key);
          const profile=publicProfile(this.cameraProfiles.forKey(key));
          if(profile)camera.profile=profile;
        }
        cameras.push(camera);
      }catch{}
    }
    this.state.devices={microphones:sources.filter(s=>!s.name.endsWith('.monitor')&&s.name!=='vidcapture_mic'&&!/[|\x00-\x1f\x7f]/.test(s.name)).map(s=>({id:s.name,name:s.description})),cameras,monitors:monitors.map(m=>({id:m.name,name:displayName(m),width:Math.floor((m.transform%2?m.height:m.width)/m.scale),height:Math.floor((m.transform%2?m.width:m.height)/m.scale),pixelWidth:m.transform%2?m.height:m.width,pixelHeight:m.transform%2?m.width:m.height,x:m.x,y:m.y,scale:m.scale,transform:m.transform}))};
    return this.publish();
  }
  async saveSettings(partial) {
    this.idleOnly();
    const settings=validateSettings(partial,this.state.settings,this.state.devices);
    if(partial.cameraCorner&&partial.cameraCorner!==this.state.settings.cameraCorner)this.cameraPlacement=null;
    const wasPreview=!!this.camera;
    let cameraChanged=['camera','cameraCorrection','cameraLighting','cameraBackground'].some(k=>settings[k]!==this.state.settings[k]);
    // Blur strength and the background image change live in a running effect.
    const effectChange={};
    if(settings.cameraBlur!==this.state.settings.cameraBlur)effectChange.blur=this.cameraEffects?.strength(settings.cameraBlur);
    if(settings.cameraBackgroundImage!==this.state.settings.cameraBackgroundImage&&settings.cameraBackground==='image')effectChange.background=this.cameraEffects?.imagePath(settings.cameraBackgroundImage);
    if(!cameraChanged&&Object.keys(effectChange).length&&this.camera?.effects){
      try{await this.cameraEffects.send(this.camera.effects.controlSocket,effectChange);}catch{cameraChanged=true;}
    }
    if(cameraChanged)await this.closeCamera();
    await fs.writeFile(path.join(this.dataDir,'settings.json.tmp'),JSON.stringify(settings,null,2),{mode:0o600});
    await fs.rename(path.join(this.dataDir,'settings.json.tmp'),path.join(this.dataDir,'settings.json'));
    this.set({settings});
    if(wasPreview && cameraChanged && settings.camera!=='none')await this.openCamera();
    else if(this.camera)await this.positionCamera(true);
    return this.publish();
  }
  async listWindows(){
    const clients=JSON.parse((await run('hyprctl',['clients','-j'])).stdout);
    return clients.filter(c=>c.mapped&&!c.hidden&&c.visible!==false&&!/^(?:vid)?capture(?:-|$)/.test(c.class||'')).map(c=>({id:c.address,title:c.title||c.class,app:c.class}));
  }
  async chooseTarget(id) {
    this.idleOnly();await this.closeCamera();
    if(typeof id==='string'&&/^window:0x[0-9a-f]+$/i.test(id)){
      const clients=JSON.parse((await run('hyprctl',['clients','-j'])).stdout);
      const client=clients.find(c=>c.address===id.slice(7)&&c.mapped&&!c.hidden&&c.visible!==false&&!/^(?:vid)?capture(?:-|$)/.test(c.class||''));
      if(!client)throw new Error('That window is no longer available. Choose it again.');
      await this.selectWindow(client);return this.set({phase:'idle'});
    }
    // Areas drawn on VidCapture's own picker overlay arrive as logical layout
    // coordinates, the same "X,Y WxH" form slurp prints.
    if(typeof id==='string'&&id.startsWith('region:')){
      const region=parseRegion(id.slice(7));
      await this.refreshDevices();
      if(!containingMonitor(this.state.devices.monitors,region))throw new Error('Choose an area within one display.');
      await this.unmarkWindow();
      return this.set({phase:'idle',error:null,target:region});
    }
    // Camera only: no screen. The camera is the one chosen in the camera setting.
    if(id==='camera'){
      await this.unmarkWindow();
      return this.set({phase:'idle',error:null,target:{kind:'camera',label:'Camera'}});
    }
    if(id!=='region' && id!=='window') {
      await this.refreshDevices();
      const m=this.state.devices.monitors.find(m=>m.id===id);
      if(!m) throw new Error('That display is no longer connected. Refresh the devices.');
      await this.unmarkWindow();
      return this.set({phase:'idle',error:null,target:{kind:'monitor',monitor:m.id,label:m.name,x:m.x,y:m.y,width:m.width,height:m.height}});
    }
    this.set({phase:'selecting',error:null});
    try {
      await this.beforePick();await delay(250);
      const {stdout}=await run('omarchy-capture-region',[id==='window'?'windows':'region'],{timeout:120000});
      const region=parseRegion(stdout);
      if(id==='window'){
        const clients=JSON.parse((await run('hyprctl',['clients','-j'])).stdout);
        const client=selectedWindow(clients,region);
        if(!client)throw new Error('Choose an application window, not the display or Capture itself.');
        await this.selectWindow(client);
        return this.set({phase:'idle'});
      }
      await this.unmarkWindow();return this.set({phase:'idle',target:region});
    }catch(e){
      if(e.code===1) return this.set({phase:'idle'});
      this.set({phase:'error',error:e.killed?'Selection timed out. Try again.':e.message});throw e;
    }finally{await this.afterPick();}
  }
  async unmarkWindow() {
    const target=this.state.target;
    if(target?.kind!=='window')return;
    const clients=JSON.parse((await run('hyprctl',['clients','-j'])).stdout);
    if(matchingWindow(clients,target))await run('hyprctl',['dispatch',`hl.dsp.window.tag({window="address:${target.address}",tag="-capture-selected"})`]);
  }
  async selectWindow(client) {
    if(this.state.phase!=='selecting')this.idleOnly();await this.unmarkWindow();
    if(!/^0x[0-9a-f]+$/i.test(client.address))throw new Error('The window identifier is invalid.');
    // The record panel draws the bright outline; the tag only marks the window.
    await run('hyprctl',['eval','hl.window_rule({name="capture-selected",match={tag="capture-selected"},no_anim=true})']);
    await run('hyprctl',['dispatch',`hl.dsp.window.tag({window="address:${client.address}",tag="+capture-selected"})`]);
    return this.set({target:windowTarget(client),error:null});
  }
  updateWindow(force=false) {
    if(this.windowUpdate)return this.windowUpdate;
    if(this.disposed||this.state.target?.kind!=='window'||(this.state.phase==='selecting'&&!force))return Promise.resolve();
    this.windowUpdate=this.trackWindow().finally(()=>{this.windowUpdate=null;});
    return this.windowUpdate;
  }
  async trackWindow() {
    const previous=this.state.target;
    const clients=JSON.parse((await run('hyprctl',['clients','-j'],{timeout:1500})).stdout);
    if(this.disposed||this.state.target!==previous)return;
    const client=matchingWindow(clients,previous);
    const next=client?windowTarget(client):{...previous,available:false};
    const monitor=containingMonitor(this.state.devices.monitors,next);
    next.available=next.available&&!!monitor;
    this.state.target=next;
    if(this.followMonitor){
      const valid=next.available&&monitor?.id===this.followMonitor;
      await this.writeFollowState(valid?next:null);
      if(!valid&&['recording','paused'].includes(this.state.phase)){
        const message=monitor&&monitor.id!==this.followMonitor?'The window moved to another display. This take was saved. Start a new take on that display.':'The selected window is no longer visible on one display. This take was saved.';
        await this.stop();this.set({error:message});return;
      }
    }
    // Crop updates must never wait for camera window commands. Keep one camera
    // adjustment in flight and let the next poll reconcile its latest position.
    if(this.camera&&next.available&&!this.cameraUpdate){
      this.cameraUpdate=this.positionCamera(false,clients).catch(e=>{
        if(!this.disposed&&this.camera)this.set({error:`Camera positioning: ${e.message}`});
      }).finally(()=>{this.cameraUpdate=null;});
    }else if(this.camera&&!next.available&&!ACTIVE.has(this.state.phase))await this.closeCamera();
    if(JSON.stringify(previous)!==JSON.stringify(next))this.publish();
  }
  async writeFollowState(target) {
    const monitor=target&&containingMonitor(this.state.devices.monitors,target);
    const values=monitor?[1,Date.now()/1000,...physicalRegion(target,monitor)]:[0,Date.now()/1000,0,0,0,0];
    const pending=this.followFile+'.'+(++this.followSequence)+'.tmp';
    await fs.writeFile(pending,values.join(' ')+'\n',{mode:0o600});
    await fs.rename(pending,this.followFile);
  }
  // Where the camera bubble sits. A camera-only take has no screen area, so its
  // preview shows on the laptop display.
  bubbleTarget() {
    const t=this.state.target;
    return (t&&t.kind!=='camera'?t:null)||this.state.devices.monitors.find(m=>m.id.startsWith('eDP'))||this.state.devices.monitors[0];
  }
  async positionCamera(verify=false,knownClients=null) {
    if(!this.camera||!this.cameraAddress)return;
    const camera=this.camera;
    const target=this.bubbleTarget();
    if(!target)return;
    let geom=cameraGeometry(target,this.state.settings.cameraSize,this.state.settings.cameraCorner,this.cameraPlacement);
    const monitor=containingMonitor(this.state.devices.monitors,target);
    for(let attempt=0;attempt<(verify?12:1);attempt++){
      if(this.camera!==camera)return;
      const clients=knownClients||JSON.parse((await run('hyprctl',['clients','-j'])).stdout);knownClients=null;
      const client=clients.find(c=>c.address===this.cameraAddress&&c.pid===camera.pid);
      if(!client){if(!verify)return;await delay(60);continue;}
      const last=this.lastCameraGeometry;
      if(!verify&&last&&client.size[0]===last.size&&client.size[1]===last.size&&(Math.abs(client.at[0]-last.x)>2||Math.abs(client.at[1]-last.y)>2)) {
        // A move not issued by the follow loop is the user's placement. Store it
        // relative to the recording target so moving that target still works.
        this.cameraPlacement={x:(client.at[0]-target.x-16)/Math.max(1,target.width-geom.size-32),y:(client.at[1]-target.y-16)/Math.max(1,target.height-geom.size-32)};
        geom=cameraGeometry(target,this.state.settings.cameraSize,this.state.settings.cameraCorner,this.cameraPlacement);
      }
      this.lastCameraGeometry=geom;
      if(client.size[0]===geom.size&&client.size[1]===geom.size&&client.at[0]===geom.x&&client.at[1]===geom.y)return;
      const window=`address:${client.address}`;
      if(monitor && !client.pinned)await run('hyprctl',['dispatch',`hl.dsp.window.pin({window="${window}",action="set"})`]);
      if(!client.floating)await run('hyprctl',['dispatch',`hl.dsp.window.float({window="${window}",action="set"})`]);
      if(client.size[0]!==geom.size||client.size[1]!==geom.size)await run('hyprctl',['dispatch',`hl.dsp.window.resize({window="${window}",x=${geom.size},y=${geom.size}})`],{timeout:1500});
      if(this.camera!==camera)return;
      if(client.at[0]!==geom.x||client.at[1]!==geom.y)await run('hyprctl',['dispatch',`hl.dsp.window.move({window="${window}",x=${geom.x},y=${geom.y}})`],{timeout:1500});
      if(verify)await delay(80);
    }
    if(verify)throw new Error('The camera could not be resized. Try Preview again.');
  }
  async refreshRecent() {
    const items=[];
    for(const name of await fs.readdir(this.outputDir)) {
      if(!isRecordingName(name)) continue;
      const p=path.join(this.outputDir,name); let s;try{s=await fs.stat(p);}catch{continue;}
      if(!s.isFile() || s.size<=0 || p===this.rawFile) continue;
      let title=null;try{title=JSON.parse(await fs.readFile(path.join(this.dataDir,name+'.json'),'utf8')).title||null;}catch{}
      items.push({path:p,name,title,bytes:s.size,created:s.mtime.toISOString()});
    }
    this.state.recent=items.sort((a,b)=>b.created.localeCompare(a.created)).slice(0,12);
  }
  async allowedFile(file) {
    if(typeof file!=='string' || path.dirname(file)!==this.outputDir || !isRecordingName(path.basename(file))) throw new Error('Choose a file from your recordings folder.');
    const real=await fs.realpath(file);if(path.dirname(real)!==await fs.realpath(this.outputDir)) throw new Error('File is outside the recordings folder.');
    return real;
  }
  async previewCamera() {
    this.idleOnly();
    if(this.camera) {await this.closeCamera();return this.publish();}
    await this.openCamera();return this.publish();
  }
  // A camera profile, when one matches this model, adds vendor commands, lens
  // correction and the Intel GPU decoder. Other cameras use none of these.
  // Camera controls chosen in Studio settings (exposure, white balance and so
  // on) apply too; a camera that refuses one keeps its own value.
  async prepareCamera(device) {
    let profile=null;
    if(this.cameraProfiles){
      const key=this.cameraKeys.get(device)||await cameraKey(device).catch(()=>null);
      profile=this.cameraProfiles.forKey(key);
    }
    const processing={profile:profile?.name||null};
    if(profile?.extensionUnit){
      try {
        const job=run('python3',[path.join(__dirname,'camera-controls.py'),device],{timeout:5000});
        job.child.stdin.end(JSON.stringify(profile.extensionUnit));
        processing.extensionUnit=JSON.parse((await job).stdout);
      }catch(e){throw new Error(`The ${profile.name} profile could not be applied. ${e.stderr?.trim()||e.message}`);}
    }
    if(this.cameraSettings)await this.cameraSettings.apply(device).catch(()=>{});
    return {profile,processing};
  }
  async openCamera() {
    if(this.state.settings.camera==='none') throw new Error('Choose a camera first.');
    await this.closeCamera();
    const target=this.bubbleTarget();
    if(!target) throw new Error('Choose an area or display for the camera.');
    if(target.width<90 || target.height<90) throw new Error('Choose a larger recording area to fit the camera.');
    const formats=await run('v4l2-ctl',['-d',this.state.settings.camera,'--list-formats-ext'],{timeout:5000});
    const mode=cameraMode(formats.stdout),circle=mode.circle;
    const device=this.state.settings.camera;
    const {profile,processing}=await this.prepareCamera(device);
    const correction=profile?.lensCorrection&&this.state.settings.cameraCorrection==='computer'?profile.lensCorrection:null;
    // Background blur or replacement runs in a separate GPU process (camera-effects.cjs).
    // If it was chosen and cannot run, the camera does not open: a take must never
    // show a background that was meant to be hidden.
    const effect=this.state.settings.cameraBackground!=='off'?this.state.settings.cameraBackground:null;
    if(effect){
      if(!this.cameraEffects||!(await this.cameraEffects.available()))throw new Error('Background effects are not installed. Run scripts/setup-camera-effects.sh, or turn the background effect off.');
      if(effect==='image')await fs.access(this.cameraEffects.imagePath(this.state.settings.cameraBackgroundImage)).catch(()=>{throw new Error('The background image is missing. Choose another one.');});
    }
    const shader=cameraShader({correction,lighting:this.state.settings.cameraLighting});
    const shaderFile=path.join(this.dataDir,'camera-processing.glsl');
    if(shader)await fs.writeFile(shaderFile,shader,{mode:0o600});
    await fs.writeFile(path.join(this.dataDir,'camera-mode.json'),JSON.stringify({device:this.state.settings.camera,...mode,...processing,softwareCorrection:!!correction,lighting:this.state.settings.cameraLighting},null,2),{mode:0o600});
    let intelDevice=null;
    if(profile?.gpuDecode==='intel' && mode.input==='mjpeg') {
      for(const name of (await fs.readdir('/sys/class/drm')).filter(n=>/^renderD\d+$/.test(n))) {
        if((await fs.readFile(`/sys/class/drm/${name}/device/vendor`,'utf8').catch(()=>'' )).trim()==='0x8086') {
          intelDevice=`/dev/dri/${name}`;break;
        }
      }
      if(!intelDevice)throw new Error(`The ${profile.name} profile needs the Intel graphics device for its low-latency preview.`);
    }
    const initialMonitor=containingMonitor(this.state.devices.monitors,target);
    const initialGeometry=cameraGeometry(target,this.state.settings.cameraSize,this.state.settings.cameraCorner,this.cameraPlacement);
    // Decode the full 4K frame, then supersample the actual overlay on the GPU.
    // Processing millions of pixels that cannot appear in the saved bubble can
    // starve the screen encoder on the shared Intel graphics device.
    const processingCircle=Math.min(circle,Math.max(720,Math.ceil(initialGeometry.size*(initialMonitor?.scale||1)*1.25/16)*16));
    const processingWidth=Math.round(mode.width*processingCircle/mode.height/2)*2;
    const cameraEnv={...process.env};
    const pipeline=intelDevice ? [
      '--hwdec=vaapi','--hwdec-codecs=mjpeg',`--vaapi-device=${intelDevice}`,
      '--gpu-api=opengl','--gpu-context=wayland',
      `--vf=lavfi=[scale_vaapi=w=${processingWidth}:h=${processingCircle}:format=nv12:mode=hq]`,
      `--video-crop=${processingCircle}x${processingCircle}+${Math.floor((processingWidth-processingCircle)/2)}+0`
    ] : ['--vf=crop=ih:ih'];
    if(intelDevice) {
      // Keep decoding and rendering on the same Intel device. The inherited
      // NVIDIA VA-API path cannot interoperate here and falls back to slow copies.
      Object.assign(cameraEnv,{LIBVA_DRIVER_NAME:'iHD',__EGL_VENDOR_LIBRARY_FILENAMES:'/usr/share/glvnd/egl_vendor.d/50_mesa.json',__GLX_VENDOR_LIBRARY_NAME:'mesa'});
      delete cameraEnv.NVD_BACKEND;
    }
    // Dedicated names keep this app's camera separate from stock Omarchy and mpv windows.
    const rule=`hl.window_rule({name="capture-camera",match={class="^capture-camera$"},float=true,pin=true,monitor=${JSON.stringify(initialMonitor?.id||'eDP-1')},no_initial_focus=true,no_follow_mouse=true,no_blur=true,no_shadow=true,no_dim=true,no_anim=true,decorate=false,border_size=0,rounding=0,opacity="1.0 override 1.0 override",tag="-default-opacity",size={${initialGeometry.size},${initialGeometry.size}}})`;
    await run('hyprctl',['eval',rule],{timeout:5000});
    let cameraLog='';
    const controlDir=await fs.mkdtemp(path.join(os.tmpdir(),'capture-camera-'));
    const socket=path.join(controlDir,'control.sock');
    let transport=null;
    if(intelDevice) {
      const binary=path.join(__dirname,'.local/bin/capture-camera-stream');
      try{await fs.access(binary);}catch{throw new Error('The camera transport is missing. Reinstall VidCapture.');}
      transport=spawn(binary,[this.state.settings.camera,String(mode.width),String(mode.height),String(mode.fps)],{stdio:['ignore','pipe','pipe']});
      let transportLog='';
      transport.stderr.on('data',b=>{transportLog=(transportLog+b).slice(-4000);cameraLog=(cameraLog+b).slice(-4000);});
      transport.once('close',()=>fs.writeFile(path.join(this.dataDir,'camera-transport.log'),transportLog,{mode:0o600}).catch(()=>{}));
      transport.on('error',e=>{cameraLog=e.message;});
    }
    let inputOptions=transport?['--demuxer-lavf-format=nut','--rebase-start-time=no','--demuxer-thread=no']:[`--demuxer-lavf-o-add=video_size=${mode.width}x${mode.height},framerate=${mode.fps}${mode.input?',input_format='+mode.input:''}`];
    let source=transport?'fd://0':`av://v4l2:${this.state.settings.camera}`,cameraInput=transport?transport.stdout:'ignore',videoPipeline=pipeline,effects=null;
    if(effect){
      // The effect process decodes the camera (Intel VA-API for the transport) and
      // sends square RGB frames; mpv then only draws them with the bubble shader.
      const size=transport?processingCircle:Math.min(mode.height,Math.max(360,processingCircle))&~1;
      const effectSocket=path.join(controlDir,'effects.sock');
      effects=spawn(this.cameraEffects.python,this.cameraEffects.args({size,input:transport?'transport':'v4l2',render:intelDevice,device:this.state.settings.camera,mode,settings:this.state.settings,socket:effectSocket}),{stdio:[transport?transport.stdout:'ignore','pipe','pipe']});
      if(transport)transport.stdout.destroy();
      effects.controlSocket=effectSocket;
      let effectsLog='';
      const ready=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('The background effect took too long to start.')),30000);
        effects.stderr.on('data',b=>{effectsLog=(effectsLog+b).slice(-4000);cameraLog=(cameraLog+b).slice(-4000);if(/^ready$/m.test(effectsLog)){clearTimeout(timer);resolve();}});
        effects.once('exit',()=>{clearTimeout(timer);reject(new Error(`The background effect could not start. ${effectsLog.replace(/^ready$/m,'').trim().split('\n').pop()||''}`.trim()));});
        effects.once('error',e=>{clearTimeout(timer);reject(e);});
      });
      try{await ready;}catch(e){
        effects.kill('SIGKILL');if(transport&&transport.exitCode===null)transport.kill('SIGTERM');
        await fs.writeFile(path.join(this.dataDir,'camera.log'),cameraLog,{mode:0o600}).catch(()=>{});
        await fs.rm(controlDir,{recursive:true,force:true}).catch(()=>{});throw e;
      }
      source='-';cameraInput=effects.stdout;
      videoPipeline=['--gpu-api=opengl','--gpu-context=wayland'];
      inputOptions=['--demuxer=rawvideo',`--demuxer-rawvideo-w=${size}`,`--demuxer-rawvideo-h=${size}`,'--demuxer-rawvideo-mp-format=rgb24',`--demuxer-rawvideo-fps=${mode.fps||30}`];
    }
    const camera=spawn('mpv',[
      source,'--no-config','--vo=gpu-next',...videoPipeline,
      `--glsl-shaders=${shaderFile}`,`--input-ipc-server=${socket}`,
      '--background=none','--panscan=1.0','--wayland-app-id=capture-camera',
      '--title=Capture camera','--no-border','--no-osc','--no-audio','--no-input-default-bindings',
      '--profile=low-latency','--untimed','--cache=no','--demuxer-readahead-secs=0',
      ...inputOptions
    ],{stdio:[cameraInput,'ignore','pipe'],env:cameraEnv});
    if(effects)effects.stdout.destroy();else if(transport)transport.stdout.destroy();
    camera.transport=transport;camera.effects=effects;
    camera.controlSocket=socket;
    camera.once('exit',()=>{
      fs.rm(controlDir,{recursive:true,force:true}).catch(()=>{});
      fs.writeFile(path.join(this.dataDir,'camera.log'),cameraLog,{mode:0o600}).catch(()=>{});
    });
    this.camera=camera;
    camera.stderr.on('data',b=>{cameraLog=(cameraLog+b).slice(-4000);});
    camera.on('error',e=>{cameraLog=e.message;});
    camera.on('exit',()=>{if(this.camera===camera){this.camera=null;this.set({cameraPreview:false,...(['recording','paused'].includes(this.state.phase)?{error:'The camera stopped. Screen recording is still running.'}:{})});}});
    try {
      let client;
      for(let i=0;i<50;i++) {
        if(camera.exitCode!==null || camera.signalCode) throw new Error('The camera could not start. Close other apps using it and try again.');
        const {stdout}=await run('hyprctl',['clients','-j']);
        client=JSON.parse(stdout).find(c=>c.class==='capture-camera' && c.pid===camera.pid);
        if(client) break;await delay(100);
      }
      if(!client) throw new Error('The camera preview did not open.');
      if(intelDevice&&!effects) {
        const decoder=await cameraCommand(socket,['get_property','hwdec-current']);
        if(decoder!=='vaapi')throw new Error('The low-latency camera decoder did not start. Recording was not started.');
      }
      this.cameraAddress=client.address;
      await this.positionCamera(true);
      if(camera.exitCode!==null || camera.signalCode) throw new Error('The camera stopped before recording could begin.');
      this.set({cameraPreview:true});
    }catch(e){await fs.writeFile(path.join(this.dataDir,'camera.log'),cameraLog,{mode:0o600});await this.closeCamera();throw e;}
  }
  async closeCamera() {
    const camera=this.camera;this.camera=null;this.cameraAddress=null;this.lastCameraGeometry=null;this.state.cameraPreview=false;
    if(camera && camera.exitCode===null && !camera.signalCode){
      // Timestamps in recorder.log show whether the camera closed after the take ended.
      this.log+=`VidCapture: camera close requested at ${new Date().toISOString()}\n`;
      camera.once('exit',(code,signal)=>{this.log+=`VidCapture: camera exited code=${code} signal=${signal} at ${new Date().toISOString()}\n`;});
      const exited=new Promise(resolve=>camera.once('exit',resolve));
      // Fed directly by the transport, MPV decodes with VA-API and scales with
      // scale_vaapi, but only reads a pipe and never opens the camera. Its quit
      // path has faulted while tearing down those filters, so end it at once; the
      // transport still stops normally below. The effects path (RGB frames, no
      // VA-API filters) and a preview that reads the camera itself still quit.
      if(camera.transport&&!camera.effects){camera.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}
      else await new Promise(resolve=>{
        const socket=net.createConnection(camera.controlSocket);
        socket.setTimeout(300);
        const done=()=>{socket.destroy();resolve();};
        socket.once('error',done);socket.once('timeout',done);
        socket.once('connect',()=>socket.end(JSON.stringify({command:['quit']})+'\n',done));
      });
      // Quit through MPV so its filters release camera frames before teardown.
      // This preview writes no media; a stuck child can be terminated directly.
      if(camera.exitCode===null&&!camera.signalCode)await Promise.race([exited,delay(2000)]);
      if(camera.exitCode===null&&!camera.signalCode){camera.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}
    }
    const effects=camera?.effects;
    if(effects && effects.exitCode===null && !effects.signalCode) {
      const exited=new Promise(resolve=>effects.once('exit',resolve));
      effects.kill('SIGTERM');await Promise.race([exited,delay(1500)]);
      if(effects.exitCode===null&&!effects.signalCode){effects.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}
    }
    const transport=camera?.transport;
    if(transport && transport.exitCode===null && !transport.signalCode) {
      const exited=new Promise(resolve=>transport.once('exit',resolve));
      transport.kill('SIGTERM');await Promise.race([exited,delay(1000)]);
      if(transport.exitCode===null&&!transport.signalCode){transport.kill('SIGKILL');await Promise.race([exited,delay(1000)]);}
    }
  }
  async start() {
    this.idleOnly();if(!this.state.target) throw new Error('Choose a window, area, or display first.');
    // Stock Omarchy's stop shortcut signals all recorder processes, so do not overlap.
    try {const {stdout}=await run('pgrep',['-x','gpu-screen-reco']);if(stdout.trim())throw new Error('Another screen recorder is running. Stop it before starting Capture.');}catch(e){if(e.code!==1)throw e;}
    const {stdout:existing}=await run('pgrep',['-f','^gpu-screen-recorder'],{timeout:3000}).catch(e=>e.code===1?{stdout:''}:Promise.reject(e));
    if(existing.trim()) throw new Error('Omarchy is already recording. Stop it before starting Capture.');
    await this.refreshDevices();
    validateSettings(this.state.settings,DEFAULTS,this.state.devices);
    if(this.state.target.kind==='window')await this.updateWindow(true);
    let target=this.state.target;
    const cameraOnly=target.kind==='camera';
    if(cameraOnly){
      const device=this.state.settings.camera;
      if(device==='none'||!this.state.devices.cameras.some(c=>c.id===device))throw new Error('Choose a camera first.');
      // The recorder reads the camera directly, so the bubble's effects cannot apply.
      if(this.state.settings.cameraBackground!=='off')throw new Error('Background effects are not available when recording only the camera. Turn the background off.');
    }
    if(target.kind==='window'&&!target.available)throw new Error('The selected window is not visible. Select it again.');
    if(!cameraOnly&&!this.state.devices.monitors.some(m=>target.x>=m.x&&target.y>=m.y&&target.x+target.width<=m.x+m.width+1&&target.y+target.height<=m.y+m.height+1))throw new Error('The selected area no longer fits a connected display. Select it again.');
    const disk=await fs.statfs(this.outputDir);if(disk.bavail*disk.bsize<1024**3)throw new Error('Less than 1 GB is free. Free some space before recording.');
    this.started=0;this.pausedAt=0;this.pauseTotal=0;this.log='';this.set({phase:'starting',error:null,elapsed:0,lastFile:null});
    try {
      let recordTarget=target;
      if(cameraOnly){
        // The preview bubble must let go of the camera before the recorder opens it.
        await this.closeCamera();
        const device=this.state.settings.camera;
        await this.prepareCamera(device);
        const formats=await run('v4l2-ctl',['-d',device,'--list-formats-ext'],{timeout:5000});
        const mode=cameraRecordMode(formats.stdout,this.state.settings.resolution);
        if(!mode.width)throw new Error('This camera has no 30 fps mode to record.');
        recordTarget={...target,device,mode};
      }
      else if(this.state.settings.camera!=='none'){
        // Keep the existing preview stream alive when starting a take.
        if(this.camera&&this.camera.exitCode===null&&!this.camera.signalCode)await this.positionCamera(true);
        else await this.openCamera();
      }else await this.closeCamera();
      const stamp=new Date().toISOString().replace(/[:.]/g,'-');
      this.rawFile=path.join(this.outputDir,`Capture-${stamp}.mkv`);
      let engine='gpu-screen-recorder';
      const env={...process.env};
      if(target.kind==='window'){
        engine=this.followEngine||path.join(__dirname,'.local/bin/gpu-screen-recorder-follow');
        try{await fs.access(engine);}catch{throw new Error('Window recording is unavailable. Reinstall VidCapture to restore it.');}
        this.followMonitor=containingMonitor(this.state.devices.monitors,target)?.id;
        await this.writeFollowState(target);env.CAPTURE_FOLLOW_STATE=this.followFile;
      }
      // The take's microphone, as one source. Default means the default input as it
      // is now; the take keeps that source and never follows a later default.
      const mic=this.state.settings.microphone;
      const micName=mic==='none'?null:mic==='default_input'?await this.resolveDefaultMic():mic;
      // Live microphone cleanup, if on. A failure stops the start so a take never
      // silently records without the cleanup that was chosen.
      const clean=this.audioChain?await this.audioChain.ensure(this.state.settings):null;
      if(this.state.micCleanupError)this.state.micCleanupError=null;
      if(clean&&this.audioChain.mic&&this.audioChain.mic!==micName)throw new Error('The default microphone changed while the recording was starting. Try again.');
      // micSource: the source the take's microphone track reads, for the controls'
      // indicator. null with no microphone.
      this.takeAudio={clean:!!clean,backup:!!(clean&&mic!=='none'&&this.state.settings.micBackup),micSource:mic==='none'?null:clean?clean:micName};
      // Every microphone take is held to its route: the recorder's streams refuse a
      // fallback (node.dont-fallback), and the guard ends the take if the route is lost.
      const plan=takePlan({settings:this.state.settings,mic:micName,clean,chainPid:clean?this.audioChain.child?.pid:null});
      this.micFaultInfo=null;this.interrupted=null;
      const child=spawn(engine,buildArgs(recordTarget,this.state.settings,this.rawFile,clean,micName),{stdio:['ignore','ignore','pipe'],env:plan?pinEnv(env):env});
      this.child=child;this.startingChild=child;
      child.stderr.on('data',b=>{this.log=(this.log+b).slice(-32000);});
      this.exitPromise=new Promise(resolve=>{child.once('error',e=>{this.log+=e.message;resolve({code:1});});child.once('exit',(code,signal)=>{this.log+=`\nVidCapture: recorder exited code=${code} signal=${signal} at ${new Date().toISOString()}\n`;resolve({code,signal});});});
      this.exitPromise.then(async result=>{
        // Only this take's own recorder can end this take: a late exit of an earlier
        // recorder never finalizes a newer one.
        if(this.child===child&&['recording','paused'].includes(this.state.phase)) await this.finish(result.code===0?null:'Recording stopped unexpectedly. Any recoverable footage has been kept.');
      }).catch(e=>this.set({phase:'error',error:e.message}));
      if(plan&&child.pid){
        const guard=new SourceGuard({plan,pid:child.pid,query:this.guardQuery,timing:this.guardTiming,onFault:f=>this.micFault(f,child,guard)});
        this.sourceGuard=guard;guard.start();
      }
      // A route fault while starting ends this take at once (micFault); startup then
      // stops at its next step and reports that ending instead of going live.
      const faulted=()=>this.faultedChild===child;
      let ready=false;
      for(let i=0;i<80;i++) {
        if(faulted())break;
        if(child.exitCode!==null||child.signalCode)throw new Error('Recording could not start. '+this.log.trim().split('\n').slice(-3).join(' ').slice(-350));
        // The muxer buffers small MKV writes. FPS diagnostics prove capture started
        // even when the first disk buffer has not been flushed yet.
        try {if((await fs.stat(this.rawFile)).size>0 || /update fps: [1-9]/.test(this.log)){ready=true;break;}}catch{}
        await delay(100);
      }
      if(!faulted()){
        if(!ready)throw new Error('The recorder did not start writing a file.');
        this.started=Date.now();
        await fs.writeFile(path.join(this.dataDir,'active.json'),JSON.stringify({pid:child.pid,file:this.rawFile,started:this.started}),{mode:0o600});
        // Nothing is awaited between this check and going live.
        if(!faulted())return this.set({phase:'recording'});
      }
      throw Object.assign(new Error('fault'),{routeFault:true});
    }catch(e){
      // A route fault owns this take's ending (containment, stop, save); startup only
      // waits for it, removes the metadata it may have written after cleanup, and
      // reports the outcome.
      if(e.routeFault||(this.faultedChild&&this.faultedChild===this.startingChild)){
        const ending=this.faulting;
        if(ending)await ending.catch(()=>{});
        if(this.state.phase!=='error'||!this.child)await fs.rm(path.join(this.dataDir,'active.json'),{force:true});
        throw new Error(this.state.error||faultMessage({fault:this.micFaultInfo.reason}));
      }
      this.stopSourceGuard();
      const live=()=>this.child&&this.child.exitCode===null&&!this.child.signalCode;
      if(live()){
        this.interrupted=this.child;this.child.kill('SIGINT');await Promise.race([this.exitPromise,delay(this.startStopMs??5000)]);
        if(live()){try{this.child.kill('SIGKILL');}catch{}await Promise.race([this.exitPromise,delay(this.faultKillMs)]);}
      }
      if(live()){
        // Still running after SIGKILL: keep the process and its file accounted for.
        // New takes and settings wait (idleOnly) until it exits; then it is let go.
        const survivor=this.child,file=this.rawFile;
        this.exitPromise.then(async()=>{
          if(this.child!==survivor)return;
          this.child=null;if(this.rawFile===file)this.rawFile=null;this.followMonitor=null;
          await this.closeCamera().catch(()=>{});await this.refreshRecent().catch(()=>{});
          if(this.state.phase==='error')this.set({error:`${e.message} The recorder has now exited.`});
        }).catch(()=>{});
        await this.writeLog().catch(()=>{});
        this.set({phase:'error',error:`${e.message} The recorder (process ${this.child.pid}) has not exited, so its file is still open.`});throw e;
      }
      this.followMonitor=null;await this.closeCamera();await this.writeLog();this.rawFile=null;await this.refreshRecent();this.set({phase:'error',error:e.message});throw e;
    }
  }
  async pause() {
    if(!['recording','paused'].includes(this.state.phase)||!this.child)throw new Error('There is no recording to pause.');
    if(!this.child.kill('SIGUSR2'))throw new Error('The recorder is no longer running.');
    if(this.state.phase==='recording'){this.pausedAt=Date.now();this.set({phase:'paused'});}else{this.pauseTotal+=Date.now()-this.pausedAt;this.pausedAt=0;this.set({phase:'recording'});}
    return this.snapshot();
  }
  async stop() {
    // A take the guard is ending is already being stopped and saved.
    if(this.faulting)return this.faulting;
    if(!['recording','paused'].includes(this.state.phase)||!this.child)throw new Error('There is no recording to stop.');
    const child=this.child;
    this.set({phase:'stopping'});this.interrupted=child;child.kill('SIGINT');
    // A route fault during this stop takes over at once (see micFault); this stop then
    // waits for that ending instead of its own timeout, so the take is saved once.
    let fault=null;
    let timer;
    const result=await Promise.race([this.exitPromise,new Promise(r=>{timer=setTimeout(()=>r(null),this.stopMs??30000);}),new Promise(r=>{this.onFaultBegin=r;}).then(box=>{fault=box.ending;return null;})]);
    clearTimeout(timer);this.onFaultBegin=null;
    if(fault||this.faulting)return fault||this.faulting;
    if(!result){
      this.set({phase:this.pausedAt?'paused':'recording',error:'The recorder is taking longer to stop. Your file is preserved. Try Stop again.'});throw new Error(this.state.error);
    }
    return this.finish(result.code===0?null:'The recorder ended with an error. Your footage has been kept.');
  }
  // Ends the take and deletes its file. Only this take's own recording is
  // removed: the raw file the recorder was writing, never anything else.
  async discard() {
    if(!['recording','paused'].includes(this.state.phase)||!this.child)throw new Error('There is no recording to discard.');
    const raw=this.rawFile;
    this.stopSourceGuard();
    this.set({phase:'stopping'});
    this.child.kill('SIGINT');
    let result=await Promise.race([this.exitPromise,delay(10000).then(()=>null)]);
    if(!result&&this.child){this.child.kill('SIGKILL');result=await Promise.race([this.exitPromise,delay(3000).then(()=>null)]);}
    await this.closeCamera();await this.writeLog().catch(()=>{});
    this.child=null;this.rawFile=null;this.followMonitor=null;this.started=0;this.pausedAt=0;this.pauseTotal=0;
    if(takeFile(raw,this.outputDir)){
      await fs.rm(raw,{force:true});
      await fs.rm(raw.replace(/\.mkv$/,'.saving.mp4'),{force:true});
    }
    await fs.rm(path.join(this.dataDir,'active.json'),{force:true});
    await this.refreshRecent();
    return this.set({phase:'idle',elapsed:0,lastFile:null,error:null,cameraPreview:false});
  }
  // The default input as one microphone source, for a take set to Default.
  async resolveDefaultMic(){
    let name='';
    try{name=String(await this.defaultSource()||'').trim();}catch{}
    if(!name||name.endsWith('.monitor')||name==='vidcapture_mic')throw new Error('There is no default microphone. Choose a microphone first.');
    return name;
  }
  stopSourceGuard(){const g=this.sourceGuard;this.sourceGuard=null;g?.stop();}
  // Called by the guard of one take. A guard that no longer belongs to the current
  // take (an earlier take, or a take already ending) changes nothing.
  micFault(f,child,guard){
    if(this.sourceGuard!==guard||this.child!==child)return null;
    this.sourceGuard=null;
    this.log=(this.log+`\n[microphone route] ${JSON.stringify(f)}\n`).slice(-32000);
    // Starting, recording, paused, or in an ordinary Stop (the guard runs until saving starts, and
    // discard stops it first): containment starts now, and a Stop in progress joins it.
    if(!['starting','recording','paused','stopping'].includes(this.state.phase))return null;
    return this.beginFault(f,child);
  }
  beginFault(f,child){
    if(this.faulting)return this.faulting;
    this.faultedChild=child;
    this.micFaultInfo=faultInfo(f);
    // The ending's own failure (saving, writing the log) is handled here: the take
    // leaves stopping with the reason and the failure, and keeps its file and process.
    this.faulting=this.endFaultedTake(f,child).catch(e=>{
      const message=faultMessage(f,this.micFaultInfo?.uncertain?'unconfirmed':null);
      this.log+=`\n[microphone route] ending the take failed: ${e?.message||e}\n`;
      return this.set({phase:'error',error:`${withoutSaved(message)} Saving the recording failed: ${e?.message||e}${this.rawFile?' The original file was kept.':''}`});
    }).finally(()=>{this.faulting=null;});
    this.onFaultBegin?.({ending:this.faulting});
    return this.faulting;
  }
  // Ends the take, with a wall-clock bound. The recorder is asked to stop and save at
  // once, and its microphone streams are muted (the supported pactl operation) and
  // confirmed by asking PipeWire again, in rounds that repeat while it saves, so a
  // stream it reopens elsewhere is muted too. Until a round confirms the mute, the
  // recorder has faultUnsafeMs from the fault being handled before it is killed; a
  // confirmed take gets faultStopMs to save. The deadline is enforced on its own
  // timer, never behind a probe. Any earlier unconfirmed time is kept in the take's
  // record and its message. A recorder still running after the kill is reported with
  // its process id and file, never returned to recording.
  async endFaultedTake(f,child){
    const begun=Date.now();
    this.set({phase:'stopping'});
    let exited=null;this.exitPromise.then(r=>{exited=r;},()=>{exited={code:1};});
    if(this.interrupted!==child){this.interrupted=child;try{child.kill('SIGINT');}catch{}}
    const interval=this.guardTiming.intervalMs??250;
    const query=this.guardQuery||this.pactl;
    let deadline=begun+this.faultUnsafeMs,safeAt=null,unsafeSince=begun,unsafeMs=0,uncertain=false,last=null,done=false;
    const containment=(async()=>{
      while(!done&&!exited){
        const c=await muteTakeMic({pid:child.pid,query,mute:this.muteStream,queryMs:this.guardTiming.queryMs,cancelled:()=>done||!!exited});
        if(done||exited||c.state==='cancelled')break;
        last=c.state;
        const now=Date.now();
        if(c.state==='unconfirmed'){
          uncertain=true;
          if(safeAt){safeAt=null;unsafeSince=now;deadline=Math.min(deadline,now+this.faultUnsafeMs);}
        }else if(!safeAt){
          safeAt=now;unsafeMs+=now-unsafeSince;unsafeSince=null;
          deadline=begun+this.faultStopMs;
        }
        await delay(interval);
      }
    })().catch(()=>{});
    // The wait itself: exit, or the deadline as it stands (checked every 10 ms).
    while(!exited&&Date.now()<deadline)await Promise.race([this.exitPromise.catch(()=>{}),delay(Math.max(1,Math.min(10,deadline-Date.now())))]);
    let killed=false,killAt=null;
    if(!exited){
      killAt=Date.now();
      this.log+=`\n[microphone route] recorder ${child.pid} did not stop in time (microphone ${safeAt?'muted':'not confirmed muted'}); killing it\n`;
      try{child.kill('SIGKILL');killed=true;}catch{}
      await Promise.race([this.exitPromise.catch(()=>{}),delay(this.faultKillMs)]);
    }
    // Stop the containment rounds first, so nothing new is started; then kill and reap
    // what is still running, wait (bounded) for the last round to settle, and drain
    // once more for anything it had already launched.
    done=true;
    const endAt=Date.now();
    if(unsafeSince!==null)unsafeMs+=endAt-unsafeSince;
    if(!safeAt)uncertain=true;
    await query.drain?.(500).catch(()=>null);
    const settled=await Promise.race([containment.then(()=>true),delay(500).then(()=>false)]);
    const probes=await query.drain?.(500).catch(()=>null);
    if(!settled)this.log+='\n[microphone route] a containment round had not settled after its probes were killed\n';
    this.micFaultInfo={...this.micFaultInfo,cut:safeAt?'muted':(last||'unconfirmed'),uncertain,unconfirmedMs:unsafeMs,
      handledMs:begun-(f.at||begun),killAfterMs:killAt?killAt-begun:null,killed,endedMs:endAt-begun,...(probes?.unreaped?.length?{probesUnreaped:probes.unreaped}:{})};
    const message=faultMessage(f,uncertain?'unconfirmed':null);
    if(!exited){
      await this.writeLog().catch(()=>{});
      // When it does exit, its file is saved then, under the same reason.
      this.exitPromise.then(()=>{if(this.child===child&&this.state.phase==='error')return this.finish(message);}).catch(e=>this.set({phase:'error',error:`${withoutSaved(message)} Saving the recording failed: ${e.message}`}));
      return this.set({phase:'error',error:`${withoutSaved(message)} The recorder (process ${child.pid}) has not exited, so its file is still open.`});
    }
    return this.finish(message);
  }
  async writeLog(){await fs.writeFile(path.join(this.dataDir,'recorder.log'),this.log,{mode:0o600});}
  async finish(warning=null) {
    if(this.finalizing)return this.finalizing;
    this.finalizing=this.finalize(warning).finally(()=>{this.finalizing=null;});return this.finalizing;
  }
  async finalize(warning) {
    this.stopSourceGuard();
    this.set({phase:'stopping'});await this.closeCamera();await this.writeLog();
    const raw=this.rawFile;let saved=raw;let error=warning;
    try {
      const {stdout}=await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',raw],{timeout:15000});
      const probe=JSON.parse(stdout);
      if(!probe.streams?.some(s=>s.codec_type==='video')||Number(probe.format?.duration)<0.1)throw new Error('The recording contains no playable video. Check the recorder log.');
      const mp4=raw.replace(/\.mkv$/,'.mp4');const pending=raw.replace(/\.mkv$/,'.saving.mp4');
      await run('ffmpeg',['-nostdin','-v','error','-i',raw,'-map','0','-c','copy','-movflags','+faststart','-n',pending],{timeout:1800000,maxBuffer:1024*1024});
      const {stdout:check}=await run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',pending],{timeout:15000});
      if(Number(JSON.parse(check).format.duration)<Number(probe.format.duration)-1)throw new Error('MP4 conversion was incomplete. Original MKV retained.');
      await fs.rename(pending,mp4);saved=mp4;await fs.unlink(raw);
    }catch(e){
      const kept=`The original recording was kept as MKV. ${e.message}`;
      // A route fault's reason stays, but it no longer claims a saved recording.
      error=error?(withoutSaved(error)!==error?`${withoutSaved(error)} ${kept}`:error):kept;
    }
    this.child=null;this.rawFile=null;this.followMonitor=null;await fs.rm(path.join(this.dataDir,'active.json'),{force:true});await this.refreshRecent();
    const exists=this.state.recent.some(f=>f.path===saved);
    if(exists){
      const s=this.state.settings,t=this.state.target;
      // screen and app give the title writer context when nothing is said.
      await fs.writeFile(path.join(this.dataDir,path.basename(saved)+'.json'),JSON.stringify({settings:s,micTrack:s.microphone==='none'?null:(s.systemAudio?1:0),systemTrack:s.systemAudio?(s.microphone==='none'?0:2):null,
        rawMicTrack:this.takeAudio?.backup?(s.systemAudio?3:1):null,micCleanup:this.takeAudio?.clean?{noise:s.micNoise,gate:s.micGate,rumble:s.micRumble}:null,
        ...(this.micFaultInfo?{micStopped:this.micFaultInfo}:{}),
        recordedAt:new Date(this.started||Date.now()).toISOString(),...(t?.kind==='camera'?{source:'camera'}:{}),screen:t?.kind==='window'?(t.label||null):t?.kind==='monitor'?(t.label||null):null,app:t?.kind==='window'?(t.class||null):null}),{mode:0o600});
    }
    if(!exists&&error&&withoutSaved(error)!==error)error=`${withoutSaved(error)} No recording was saved.`;
    return this.set({phase:exists?'saved':'error',lastFile:exists?saved:null,error:error||(!exists?'No recording was saved.':null),cameraPreview:false});
  }
  // Gives a recording a new name, moving every sidecar keyed by its file name
  // (metadata, transcript, waveform caches) along with it.
  async renameRecording(file,stem){
    const real=await this.allowedFile(file);
    if(this.rawFile&&path.resolve(real)===path.resolve(this.rawFile))throw new Error('This recording is still being saved.');
    const ext=path.extname(real),from=path.basename(real);
    const clean=String(stem||'').replace(/[\/\\:*?"<>|\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().replace(/^\.+/,'').slice(0,120);
    if(!clean)throw new Error('Enter a name.');
    let to=clean+ext;
    if(to===from)return real;
    for(let n=2;;n++){
      try{await fs.access(path.join(this.outputDir,to));to=`${clean} ${n}${ext}`;}catch{break;}
      if(n>99)throw new Error('Too many recordings share this name.');
    }
    const dest=path.join(this.outputDir,to);
    // Edited and enhanced copies of this recording keep its name as their prefix.
    const fromStem=path.basename(from,ext),toStem=path.basename(to,ext);
    const moves=[[from,to]];
    for(const name of await fs.readdir(this.outputDir).catch(()=>[])){
      if(name===from||!isRecordingName(name)||versionBase(name)!==fromStem)continue;
      const next=toStem+name.slice(fromStem.length);
      if(await fs.access(path.join(this.outputDir,next)).then(()=>true,()=>false))continue;
      moves.push([name,next]);
    }
    const sidecars=await fs.readdir(this.dataDir).catch(()=>[]);
    const patch={};
    for(const [a,b] of moves){
      const src=path.join(this.outputDir,a),dst=path.join(this.outputDir,b);
      try{await fs.rename(src,dst);}catch(e){if(a===from)throw e;continue;}
      for(const name of sidecars)if(name.startsWith(a+'.'))await fs.rename(path.join(this.dataDir,name),path.join(this.dataDir,b+name.slice(a.length))).catch(()=>{});
      if(this.state.lastFile===src)patch.lastFile=dst;
      if(this.state.share?.file===src)patch.share={...this.state.share,file:dst};
    }
    await this.refreshRecent();
    this.set({...patch,renamed:{from:real,to:dest,at:Date.now()}});
    return dest;
  }
  // Where new recordings are saved. Existing recordings stay where they are.
  async setOutputDir(dir){
    this.idleOnly();
    if(this.fixedOutput)throw new Error('The recordings folder is fixed for this session.');
    if(typeof dir!=='string'||!path.isAbsolute(dir))throw new Error('Choose a folder.');
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const real=await fs.realpath(dir);
    await fs.access(real,fsConstants.W_OK).catch(()=>{throw new Error('VidCapture cannot save to that folder.');});
    this.outputDir=real;
    await fs.writeFile(path.join(this.dataDir,'location.json.tmp'),JSON.stringify({outputDir:real}),{mode:0o600});
    await fs.rename(path.join(this.dataDir,'location.json.tmp'),path.join(this.dataDir,'location.json'));
    await this.refreshRecent();
    return this.set({outputDir:real,lastFile:null});
  }
  async dispose(){this.disposed=true;this.stopSourceGuard();await this.pactl.drain?.(500).catch(()=>{});clearInterval(this.followTimer);await this.unmarkWindow();clearInterval(this.timer);clearTimeout(this.deviceRefreshTimer);this.deviceWatcher?.close();await this.closeCamera();}
}
module.exports={Recorder,takeFile,validateSettings,parseRegion,buildArgs,cameraGeometry,isRecordingName,DEFAULTS,ACTIVE};
