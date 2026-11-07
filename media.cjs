const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const PRESET='16e995ab0baa5adf0711f14c95bc9e6191afa03b02752e20771ced0f864738a8';
// Modest noise reduction and bounded, slowly changing gain protect speech and pauses.
const FAST_AUDIO='aformat=sample_rates=48000:channel_layouts=mono,highpass=f=70,afftdn=nr=8:nf=-45:tn=1:gs=5,dynaudnorm=f=500:g=15:p=0.85:m=3:r=0.16:t=0.01';
const PEAK_GUARD='alimiter=limit=0.708:level=false:latency=true';
async function hash(file){const h=crypto.createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const MAX_SECTIONS=600;
function validKeep(keep,duration){
  if(!Array.isArray(keep)||!keep.length||keep.length>MAX_SECTIONS)throw new Error(`Keep at least one section, with no more than ${MAX_SECTIONS} sections.`);
  let end=0;
  for(const p of keep){if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<end-0.00001||p[0]<0||p[1]>duration+0.01||p[1]-p[0]<0.099)throw new Error('Each kept section must be ordered, inside the recording, and at least 0.1 seconds long.');end=p[1];}
  return keep.map(p=>[Math.max(0,p[0]),Math.min(duration,p[1])]);
}
// Intel graphics encoding keeps long exports off the CPU. QP 22 measured at or above the
// previous libx264 CRF 18 quality on real screen recordings (PSNR and SSIM), with slightly larger files.
const HARDWARE_QP='22';
async function intelRenderNode(root='/sys/class/drm'){
  try{for(const name of (await fs.readdir(root)).filter(n=>/^renderD\d+$/.test(n)).sort()){if((await fs.readFile(path.join(root,name,'device/vendor'),'utf8').catch(()=>'')).trim()==='0x8086')return `/dev/dri/${name}`;}}catch{}
  return null;
}
// Decoding on the GPU only when the source is ordinary 8-bit 4:2:0 H.264 the Intel decoder supports.
function hardwareDecodable(video){return video?.codec_name==='h264'&&['yuv420p','yuvj420p'].includes(video.pix_fmt)&&['Constrained Baseline','Baseline','Main','High'].includes(video.profile)&&video.width<=4096&&video.height<=4096;}
function exportArgs(file,graph,temp,encoder,{device,video}={}){
  const audio=['-c:a','aac','-b:a','192k','-movflags','+faststart','-n',temp];
  const maps=outputs=>outputs.flatMap(o=>['-map',o]);
  if(encoder!=='h264_vaapi')return ['-nostdin','-v','error','-i',file,'-filter_complex',graph.filter,...maps(graph.outputs),'-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',...audio];
  const encode=['-c:v','h264_vaapi','-rc_mode','CQP','-qp',HARDWARE_QP,'-profile:v','high'];
  if(hardwareDecodable(video))return ['-nostdin','-v','error','-hwaccel','vaapi','-hwaccel_device',device,'-hwaccel_output_format','vaapi','-i',file,'-filter_complex',graph.filter,...maps(graph.outputs),...encode,...audio];
  return ['-nostdin','-v','error','-init_hw_device',`vaapi=capture:${device}`,'-filter_hw_device','capture','-i',file,'-filter_complex',`${graph.filter};[video]format=nv12,hwupload[hwvideo]`,...maps(['[hwvideo]',...graph.outputs.slice(1)]),...encode,...audio];
}
// Up to this many sections, each one is trimmed separately (the long-tested path).
// Beyond it, every trim branch would receive every frame, so a transcript edit with
// hundreds of small cuts drops removed frames with select filters instead. Audio is
// split into 5 ms blocks first so cuts land within 5 ms. Long expressions are
// grouped because FFmpeg rejects a single expression with hundreds of terms.
const TRIM_SECTIONS=24,CUT_GROUP=40;
// Enhancement keeps the timeline, so the source's cut plan carries over to the
// enhanced copy. Ends are clamped to the copy's own measured duration.
function carryKeep(keep,duration){
  try{return validKeep((keep||[]).map(([a,b])=>[a,Math.min(b,duration)]).filter(([a,b])=>b-a>=0.1),duration);}
  catch{return [[0,duration]];}
}
function cutsFrom(keep){const cuts=[];let prev=0;for(const [a,b] of keep){if(a>prev+1e-6)cuts.push([prev,a]);prev=b;}return {cuts,tail:prev};}
function selectGraph(keep,audioCount){
  const {cuts,tail}=cutsFrom(keep),n=v=>Number(v.toFixed(6));
  const all=[...cuts,[tail,1e9]],groups=[];for(let i=0;i<all.length;i+=CUT_GROUP)groups.push(all.slice(i,i+CUT_GROUP));
  const drop=kind=>groups.map(g=>`${kind}=${g.map(([a,b])=>`not(gte(t\\,${n(a)})*lt(t\\,${n(b)}))`).join('*')}`).join(',');
  // Removing a cut shifts every later frame back by its length. Applying the latest
  // group first keeps each comparison on the original timeline.
  const shiftGroups=[];for(let i=0;i<cuts.length;i+=CUT_GROUP)shiftGroups.push(cuts.slice(i,i+CUT_GROUP));
  const shift=shiftGroups.reverse().map(g=>`setpts=PTS-(${g.map(([a,b])=>`gte(T\\,${n(b)})*${n(b-a)}`).join('+')})/TB`);
  const filters=[`[0:v:0]${drop('select')}${shift.length?','+shift.join(','):''}[video]`];
  for(let j=0;j<audioCount;j++)filters.push(`[0:a:${j}]aresample=async=1:first_pts=0,asetnsamples=n=240:p=0,${drop('aselect')},asetpts=N/SR/TB[audio${j}]`);
  return {filter:filters.join(';'),outputs:['[video]',...Array.from({length:audioCount},(_,j)=>`[audio${j}]`)]};
}
function editGraph(keep,audioCount){
  if(keep.length>TRIM_SECTIONS)return selectGraph(keep,audioCount);
  const filters=[],inputs=[];
  keep.forEach(([a,b],i)=>{
    filters.push(`[0:v:0]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`);inputs.push(`[v${i}]`);
    for(let j=0;j<audioCount;j++){filters.push(`[0:a:${j}]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}_${j}]`);inputs.push(`[a${i}_${j}]`);}
  });
  const outputs=['[video]',...Array.from({length:audioCount},(_,j)=>`[audio${j}]`)];
  filters.push(`${inputs.join('')}concat=n=${keep.length}:v=1:a=${audioCount}${outputs.join('')}`);
  return {filter:filters.join(';'),outputs};
}
class MediaTools{
  constructor(recorder){this.rec=recorder;this.waveforms=new Map();this.waveformProcesses=new Set();this.proc=null;this.cancelled=false;this.task=null;this.rec.state.job=null;this.folioRoot=process.env.NARRATION_FOLIO_ROOT||path.join(os.homedir(),'.local/share/narration-studio/folio');this.runtime=process.env.VOICE_LAB_RUNTIME||path.join(os.homedir(),'.local/share/folio');}
  // CAPTURE_EXPORT_ENCODER=libx264 forces software encoding. The render node lookup is cached per app run.
  hardwareDevice(){if(process.env.CAPTURE_EXPORT_ENCODER==='libx264')return Promise.resolve(null);return this.renderNode??=intelRenderNode();}
  async probe(file){return JSON.parse((await run('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{timeout:15000})).stdout);}
  metadataPath(file){return path.join(this.rec.dataDir,path.basename(file)+'.json');}
  async metadata(file){try{return JSON.parse(await fs.readFile(this.metadataPath(file),'utf8'));}catch{return {};}}
  async getMedia(file){
    file=await this.rec.allowedFile(file);const probe=await this.probe(file);const video=probe.streams.find(s=>s.codec_type==='video');
    if(!video)throw new Error('This file has no video.');
    const duration=Number(probe.format.duration);if(!Number.isFinite(duration)||duration<=0)throw new Error('The recording has no readable duration.');
    const meta=await this.metadata(file);let keep=[[0,duration]];
    try{keep=validKeep(meta.keep,duration);}catch{}
    const audios=probe.streams.filter(s=>s.codec_type==='audio');
    const quickAudioReady=await fs.access(path.join(__dirname,'capture_voice_profile.json')).then(()=>fs.access(path.join(this.runtime,'f-venv/bin/python'))).then(()=>true,()=>false);
    const folioReady=await fs.access(path.join(__dirname,'capture_folio.py')).then(()=>fs.access(path.join(this.folioRoot,'bin/folio'))).then(()=>true,()=>false);
    // Editing is one ongoing project: an enhanced copy re-enhances from its
    // source audio, and a saved version points back to what it was cut from.
    const exists=f=>typeof f==='string'?fs.access(f).then(()=>f,()=>null):Promise.resolve(null);
    const canEnhance=Number.isInteger(meta.micTrack)&&meta.micTrack>=0&&meta.micTrack<audios.length;
    let enhanceSource=canEnhance?file:null;
    if(!enhanceSource&&await exists(meta.enhancedFrom)){const m=await this.metadata(meta.enhancedFrom);if(Number.isInteger(m.micTrack)&&m.micTrack>=0)enhanceSource=meta.enhancedFrom;}
    const enhanced=meta.enhancedFrom?(meta.folioReceipt?'folio':meta.audioEnhancement?.mode?.startsWith('quick')?'quick':'fast'):null;
    const editedFrom=await exists(meta.editedFrom);
    return {enhanced,enhanceSource,editedFrom,quickAudioReady,folioReady,path:file,name:path.basename(file),url:`capture-media://recording/${encodeURIComponent(path.basename(file))}`,duration,width:video.width,height:video.height,hasAudio:audios.length>0,canEnhance:Number.isInteger(meta.micTrack)&&meta.micTrack>=0&&meta.micTrack<audios.length,keep};
  }
  async getWaveform(file) {
    file=await this.rec.allowedFile(file);
    const stat=await fs.stat(file),key=`${file}:${stat.size}:${stat.mtimeMs}`;
    if(this.waveforms.has(key))return this.waveforms.get(key);
    const work=(async()=>{
      const info=await this.getMedia(file);
      if(!info.hasAudio)return {duration:info.duration,peaks:[],hasAudio:false};
      const bins=Math.min(24000,Math.max(1024,Math.ceil(info.duration*100)));
      const peaks=new Float32Array(bins),rate=8000;let sample=0,pending=Buffer.alloc(0);
      await new Promise((resolve,reject)=>{
        const child=spawn('ffmpeg',['-nostdin','-v','error','-threads','1','-i',file,'-map','0:a:0','-vn','-af','aresample=async=1:first_pts=0','-ac','1','-ar',String(rate),'-f','s16le','pipe:1'],{stdio:['ignore','pipe','pipe']});
        this.waveformProcesses.add(child);let error='';
        const timeout=setTimeout(()=>child.kill('SIGKILL'),120000);timeout.unref();
        child.stderr.on('data',b=>{error=(error+b).slice(-2000);});
        child.stdout.on('data',chunk=>{
          const bytes=pending.length?Buffer.concat([pending,chunk]):chunk;
          const count=bytes.length-(bytes.length%2);
          for(let i=0;i<count;i+=2,sample++) {
            const bin=Math.min(bins-1,Math.floor(sample/(rate*info.duration)*bins));
            peaks[bin]=Math.max(peaks[bin],Math.abs(bytes.readInt16LE(i))/32768);
          }
          pending=bytes.subarray(count);
        });
        child.once('error',reject);
        child.once('close',code=>{clearTimeout(timeout);this.waveformProcesses.delete(child);code===0?resolve():reject(new Error(error.trim()||'Audio waveform could not be loaded.'));});
      });
      return {duration:info.duration,peaks:Array.from(peaks),hasAudio:true};
    })();
    this.waveforms.set(key,work);while(this.waveforms.size>3)this.waveforms.delete(this.waveforms.keys().next().value);
    try{return await work;}catch(error){this.waveforms.delete(key);throw error;}
  }
  dispose(){for(const child of this.waveformProcesses)child.kill('SIGTERM');this.waveforms.clear();}
  async saveEdits(file,keep){
    file=await this.rec.allowedFile(file);const info=await this.getMedia(file);keep=validKeep((Array.isArray(keep)?keep:[]).map(p=>Array.isArray(p)&&p.length===2?[p[0],Math.min(p[1],info.duration)]:p),info.duration);
    const meta=await this.metadata(file);await fs.writeFile(this.metadataPath(file)+'.tmp',JSON.stringify({...meta,keep}),{mode:0o600});await fs.rename(this.metadataPath(file)+'.tmp',this.metadataPath(file));return {keep};
  }
  startJob(kind,stage,work){
    this.rec.idleOnly();this.cancelled=false;this.jobLog='';const startedAt=Date.now();this.rec.set({job:{running:true,kind,stage,error:null,output:null},error:null});
    this.task=(async()=>{
      try{const output=await work();if(this.cancelled)throw new Error('Processing canceled.');
        if(['folio','fast-audio','quick-audio'].includes(kind)&&this.onEnhanced)await this.onEnhanced(output).catch(()=>{});await this.rec.refreshRecent();this.rec.set({job:{running:false,kind,stage:'Finished',error:null,output},phase:'saved',lastFile:output});}
      catch(e){const error=this.cancelled?'Processing canceled. The original is unchanged.':e.message;this.rec.set({job:{running:false,kind,stage:this.cancelled?'Canceled':'Could not finish',error,output:null},error});}
      finally{
        if(['folio','fast-audio','quick-audio'].includes(kind)){
          const record={...this.rec.state.job,startedAt,elapsedSeconds:(Date.now()-startedAt)/1000,diagnosticLog:this.jobLog};
          await fs.writeFile(path.join(this.rec.dataDir,`audio-job-${startedAt}.json`),JSON.stringify(record,null,2),{mode:0o600}).catch(()=>{});
        }
        this.proc=null;this.task=null;
      }
    })();
    return this.rec.snapshot();
  }
  stage(stage){if(this.cancelled)throw new Error('Processing canceled.');this.rec.set({job:{...this.rec.state.job,stage}});}
  process(command,args,options={}){
    if(this.cancelled)return Promise.reject(new Error('Processing canceled.'));
    return new Promise((resolve,reject)=>{
      const {onOutput,onDiagnostic,...spawnOptions}=options;
      const child=spawn(command,args,{detached:true,stdio:['ignore','pipe','pipe'],...spawnOptions});this.proc=child;let stdout='',stderr='';
      const record=b=>{if(['folio','quick-audio'].includes(this.rec.state.job?.kind))this.jobLog=(this.jobLog+b).slice(-24000);};
      child.stdout.on('data',b=>{stdout=(stdout+b).slice(-200000);record(b);if(!this.cancelled)onOutput?.(b.toString());});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);record(b);if(!this.cancelled)onDiagnostic?.(b.toString());});
      child.once('error',reject);child.once('close',(code,signal)=>{if(this.proc===child)this.proc=null;if(this.cancelled)reject(new Error('Processing canceled.'));else if(code!==0)reject(new Error(stderr.trim().split('\n').slice(-4).join('\n')||`${command} stopped (${signal||code}).`));else resolve({stdout,stderr});});
    });
  }
  async cancelJob(){
    if(!this.rec.state.job?.running)return this.rec.snapshot();this.cancelled=true;this.rec.set({job:{...this.rec.state.job,stage:'Canceling'}});
    const child=this.proc;if(child){try{process.kill(-child.pid,'SIGTERM');}catch{};const t=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);t.unref();}
    return this.rec.snapshot();
  }
  exportEdit(file,keep){return this.startJob('edit','Preparing edited copy',()=>this.createEditedCopy(file,keep));}
  async createEditedCopy(file,keep){
    file=await this.rec.allowedFile(file);const probe=await this.probe(file);const duration=Number(probe.format.duration);keep=validKeep(keep,duration);
    const audioCount=probe.streams.filter(s=>s.codec_type==='audio').length;
    const graph=editGraph(keep,audioCount);
    const output=path.join(this.rec.outputDir,`${path.basename(file,path.extname(file))}-edited-${Date.now()}.mp4`);
    const temp=output.replace(/\.mp4$/,'.saving.mp4');const expected=keep.reduce((n,[a,b])=>n+b-a,0);
    try{
      this.stage('Saving edited copy');const started=Date.now(),source=probe.streams.find(s=>s.codec_type==='video');
      const check=async()=>{
        const result=await this.probe(temp);if(Math.abs(Number(result.format.duration)-expected)>Math.max(0.25,keep.length/15))throw new Error('Edited duration did not match the selected sections. Original kept.');
        const video=result.streams.find(s=>s.codec_type==='video');
        if(video?.codec_name!=='h264'||video.width!==source.width||video.height!==source.height||result.streams.filter(s=>s.codec_type==='audio').length!==audioCount)throw new Error('Edited copy failed its stream check.');
        return result;
      };
      let encoder='libx264',result,fallback=null;const device=await this.hardwareDevice();
      if(device){
        try{await this.process('ffmpeg',exportArgs(file,graph,temp,'h264_vaapi',{device,video:source}),{env:{...process.env,LIBVA_DRIVER_NAME:'iHD'}});result=await check();encoder='h264_vaapi';}
        catch(error){if(this.cancelled)throw error;fallback=error.message.slice(0,500);await fs.rm(temp,{force:true});this.stage('Saving edited copy');}
      }
      if(!result){await this.process('ffmpeg',exportArgs(file,graph,temp,'libx264'));result=await check();}
      const meta=await this.metadata(file);
      this.stage('Finishing edited copy');await fs.rename(temp,output);
      await fs.writeFile(this.metadataPath(output),JSON.stringify({...meta,keep:[[0,Number(result.format.duration)]],editedFrom:file,sourceKeep:keep,export:{encoder,elapsedSeconds:(Date.now()-started)/1000,...(fallback?{hardwareFallback:fallback}:{})}}),{mode:0o600});return output;
    }finally{await fs.rm(temp,{force:true});}
  }
  enhanceAudioFast(file){return this.startJob('fast-audio','Preparing fast audio cleanup',async()=>{
    const started=Date.now();file=await this.rec.allowedFile(file);
    const info=await this.getMedia(file),meta=await this.metadata(file);
    if(!info.canEnhance)throw new Error('This recording has no isolated microphone track to enhance.');
    const probe=await this.probe(file),audios=probe.streams.filter(s=>s.codec_type==='audio');
    const system=meta.systemTrack;
    if(system!=null&&(!Number.isInteger(system)||system<0||system>=audios.length||system===meta.micTrack))throw new Error('The system audio track could not be identified safely.');
    const disk=await fs.statfs(this.rec.outputDir),source=await fs.stat(file);
    if(disk.bavail*disk.bsize<source.size+info.duration*32000+64*1024**2)throw new Error('There is not enough free space for a separate enhanced copy.');
    const output=path.join(this.rec.outputDir,`${path.basename(file,path.extname(file))}-enhanced-${Date.now()}.mp4`);
    const pending=output.replace(/\.mp4$/,'.saving.mp4');
    let graph=`[0:a:${meta.micTrack}]${FAST_AUDIO}[voice];`;
    graph+=system==null?`[voice]${PEAK_GUARD}[audio]`:`[voice][0:a:${system}]amix=inputs=2:duration=longest:normalize=0,${PEAK_GUARD}[audio]`;
    let progressBuffer='';
    try{
      this.stage('Cleaning audio: 0%');
      await this.process('ffmpeg',['-nostdin','-v','error','-threads','2','-i',file,'-filter_complex_threads','2','-filter_complex',graph,'-map','0:v:0','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-movflags','+faststart','-progress','pipe:1','-nostats','-n',pending],{onOutput:chunk=>{
        progressBuffer+=chunk;const lines=progressBuffer.split('\n');progressBuffer=lines.pop();
        for(const line of lines){const m=/^out_time_us=(\d+)$/.exec(line);if(m){const percent=Math.min(99,Math.floor(Number(m[1])/1e6/info.duration*100));this.stage(`Cleaning audio: ${percent}% · ${Math.round((Date.now()-started)/1000)} seconds elapsed`);}}
      }});
      this.stage('Checking audio and video timing');
      const check=await this.probe(pending),video=check.streams.find(s=>s.codec_type==='video'),originalVideo=probe.streams.find(s=>s.codec_type==='video');
      const audio=check.streams.filter(s=>s.codec_type==='audio');
      if(!video||video.codec_name!==originalVideo.codec_name||video.width!==originalVideo.width||video.height!==originalVideo.height||audio.length!==1||Math.abs(Number(check.format.duration)-info.duration)>0.15||Math.abs(Number(audio[0].duration)-Number(audios[meta.micTrack].duration))>0.15)throw new Error('Enhanced copy failed its audio/video timing check. The original is unchanged.');
      this.stage('Finishing enhanced copy');
      await fs.writeFile(this.metadataPath(output),JSON.stringify({enhancedFrom:file,micTrack:null,systemTrack:null,keep:carryKeep(info.keep,Number(check.format.duration)),audioEnhancement:{mode:'fast-cleanup-v1',elapsedSeconds:(Date.now()-started)/1000,filter:graph,videoStreamCopied:true}}),{mode:0o600});
      await fs.rename(pending,output);return output;
    }catch(error){await fs.rm(this.metadataPath(output),{force:true});throw error;}
    finally{await fs.rm(pending,{force:true});}
  });}
  enhanceAudioQuick(file,options={}){return this.startJob('quick-audio','Preparing quick studio audio',async()=>{
    const noiseReduction=options?.noiseReduction??'standard';
    if(!['standard','stronger'].includes(noiseReduction))throw new Error('Choose a supported noise reduction setting.');
    const started=Date.now();file=await this.rec.allowedFile(file);
    const info=await this.getMedia(file),meta=await this.metadata(file);
    if(!info.canEnhance)throw new Error('This recording has no isolated microphone track to enhance.');
    const probe=await this.probe(file),audios=probe.streams.filter(s=>s.codec_type==='audio'),system=meta.systemTrack;
    if(system!=null&&(!Number.isInteger(system)||system<0||system>=audios.length||system===meta.micTrack))throw new Error('The system audio track could not be identified safely.');
    const disk=await fs.statfs(this.rec.outputDir),sourceStat=await fs.stat(file);
    if(disk.bavail*disk.bsize<sourceStat.size+info.duration*600000+128*1024**2)throw new Error('There is not enough free space for a separate enhanced copy.');
    const work=await fs.mkdtemp(path.join(this.rec.outputDir,'.quick-audio-'));
    const source=path.join(work,'microphone.wav'),enhanced=path.join(work,'enhanced.wav'),pending=path.join(work,'output.mp4');
    const output=path.join(this.rec.outputDir,`${path.basename(file,path.extname(file))}-quick-studio-${Date.now()}.mp4`);
    const script=path.join(__dirname,'capture_quick_voice.py'),profile=path.join(__dirname,'capture_voice_profile.json');
    try{
      await this.process('ffmpeg',['-nostdin','-v','error','-threads','2','-i',file,'-map',`0:a:${meta.micTrack}`,'-ac','1','-ar','48000','-c:a','pcm_f32le','-n',source]);
      const input=await this.probe(source),inputFrames=Number(input.streams[0].duration_ts);
      let buffer='';
      await this.process(path.join(this.runtime,'f-venv/bin/python'),[script,source,enhanced,'--profile',profile,'--noise-reduction',noiseReduction],{env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'1'},onOutput:chunk=>{
        buffer+=chunk;const lines=buffer.split('\n');buffer=lines.pop().slice(-4000);
        for(const line of lines){if(!line.startsWith('CAPTURE_PROGRESS '))continue;let progress;try{progress=JSON.parse(line.slice(17));}catch{continue;}
          if(typeof progress.stage==='string'&&Number.isFinite(progress.percent))this.stage(`${progress.stage}: ${progress.percent}% · ${Math.round((Date.now()-started)/1000)} seconds elapsed`);
        }
      }});
      const receipt=JSON.parse(await fs.readFile(enhanced+'.json','utf8')),audioProbe=await this.probe(enhanced);
      if(receipt.version!=='quick-neural-tone-v1'||receipt.samples!==inputFrames||receipt.referenceAudioRead!==false||!Number.isFinite(receipt.samplePeak)||receipt.samplePeak>.71||Number(audioProbe.streams[0].duration_ts)!==inputFrames)throw new Error('Quick studio audio failed its timing or peak check.');
      this.stage('Saving video with enhanced audio');
      const args=['-nostdin','-v','error','-threads','2','-i',file,'-i',enhanced];
      if(system!=null)args.push('-filter_complex_threads','2','-filter_complex',`[1:a:0][0:a:${system}]amix=inputs=2:duration=longest:normalize=0,${PEAK_GUARD}[audio]`,'-map','0:v:0','-map','[audio]');
      else args.push('-map','0:v:0','-map','1:a:0');
      args.push('-c:v','copy','-c:a','aac','-aac_coder','fast','-b:a','192k','-movflags','+faststart','-n',pending);
      await this.process('ffmpeg',args);
      const check=await this.probe(pending),video=check.streams.find(s=>s.codec_type==='video'),originalVideo=probe.streams.find(s=>s.codec_type==='video'),audio=check.streams.filter(s=>s.codec_type==='audio');
      if(!video||video.codec_name!==originalVideo.codec_name||video.width!==originalVideo.width||video.height!==originalVideo.height||audio.length!==1||Math.abs(Number(check.format.duration)-info.duration)>0.15||Math.abs(Number(audio[0].duration)-Number(audios[meta.micTrack].duration))>0.15)throw new Error('Enhanced copy failed its audio/video timing check. The original is unchanged.');
      this.stage('Finishing enhanced copy');
      await fs.writeFile(this.metadataPath(output),JSON.stringify({enhancedFrom:file,micTrack:null,systemTrack:null,keep:carryKeep(info.keep,Number(check.format.duration)),audioEnhancement:{...receipt,mode:receipt.version,elapsedSeconds:(Date.now()-started)/1000,videoStreamCopied:true,processorSHA256:await hash(script),profileSHA256:await hash(profile)}}),{mode:0o600});
      await fs.rename(pending,output);return output;
    }catch(error){await fs.rm(this.metadataPath(output),{force:true});throw error;}
    finally{await fs.rm(work,{recursive:true,force:true});}
  });}
  enhanceAudio(file){return this.startJob('folio','Preparing audio for Folio',async()=>{
    file=await this.rec.allowedFile(file);const info=await this.getMedia(file);if(!info.canEnhance)throw new Error('This recording has no isolated microphone track to enhance.');
    if(info.duration<5)throw new Error('Folio needs at least five seconds of speech with quiet pauses.');
    const meta=await this.metadata(file);const cli=path.join(this.folioRoot,'bin/folio');await fs.access(cli);
    if(await hash(path.join(this.folioRoot,'presets/studio-v1.json'))!==PRESET)throw new Error('The installed Folio preset does not match Narration Studio.');
    // Folio checks its full working space on a fresh run. A verified cache hit
    // needs only room for extracted audio and the delivered video copy.
    const disk=await fs.statfs(this.rec.outputDir);const required=info.duration*48000*3+(await fs.stat(file)).size+1024**3;
    if(disk.bavail*disk.bsize<required)throw new Error('There is not enough temporary space for the enhanced video copy.');
    const work=await fs.mkdtemp(path.join(this.rec.outputDir,'.folio-'));const source=path.join(work,'microphone.wav'),enhanced=path.join(work,'enhanced.wav');
    const output=path.join(this.rec.outputDir,`${path.basename(file,path.extname(file))}-folio-${Date.now()}.mp4`);const pending=path.join(work,'output.mp4');
    try{
      await this.process('ffmpeg',['-nostdin','-v','error','-i',file,'-map',`0:a:${meta.micTrack}`,'-ac','1','-ar','48000','-c:a','pcm_s24le','-n',source]);
      const inputProbe=await this.probe(source);const inputFrames=Number(inputProbe.streams[0].duration_ts);const sourceHash=await hash(source);
      this.stage('Enhancing voice with Folio');
      const started=Date.now(),buffers={output:'',diagnostic:''};
      const phases={'source voice':'Preparing natural voice','room and voice cleanup':'Removing room sound','vocal density':'Building vocal body','early Folio and speech protection':'Blending restored voice','early tone and continuous floor':'Finishing voice tone','blending and final protected cleanup':'Blending and mastering'};
      const progress=(stream,chunk)=>{
        buffers[stream]+=chunk;const lines=buffers[stream].split('\n');buffers[stream]=lines.pop().slice(-4000);
        for(const line of lines){
          let stage=null;
          if(line.startsWith('CAPTURE_PROGRESS ')){try{stage=JSON.parse(line.slice(17)).stage;}catch{}}
          const restored=/^Restored ([\d.]+) \/ ([\d.]+) s/.exec(line);
          if(restored&&+restored[2]>0)stage=`Restoring voice: ${Math.min(100,Math.round(+restored[1]/+restored[2]*100))}%`;
          const phase=/^(.+): [\d.]+s$/.exec(line);if(phase&&phases[phase[1]])stage=phases[phase[1]];
          if(stage)this.stage(`${stage} · ${Math.round((Date.now()-started)/1000)} seconds elapsed`);
        }
      };
      await this.process(path.join(this.runtime,'f-venv/bin/python'),[path.join(__dirname,'capture_folio.py'),'--folio-root',this.folioRoot,'--cache',path.join(this.rec.dataDir,'folio-cache'),'--input',source,'--output',enhanced],{env:{...process.env,VOICE_LAB_RUNTIME:this.runtime,TMPDIR:work,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'},onOutput:b=>progress('output',b),onDiagnostic:b=>progress('diagnostic',b)});
      this.stage('Checking enhanced audio');
      const receipt=JSON.parse(await fs.readFile(path.join(work,'enhanced.json'),'utf8'));
      if(receipt.recipe!=='folio-studio-v1'||receipt.folio_version!=='0.3.0'||receipt.sample_rate!==48000||receipt.output_subtype!=='PCM_24'||receipt.source_sha256!==sourceHash||receipt.output_sha256!==await hash(enhanced)||receipt.preset_sha256!==PRESET||receipt.samples!==inputFrames||receipt.speech_edited!==false)throw new Error('Folio output did not match the original audio timing or receipt.');
      if(receipt.mastering?.revision!=='master-me-narration-v1')throw new Error('Folio mastering does not match Narration Studio.');
      for(const name of ['capture_folio.py','capture_folio_optimizations.py'])if(receipt.capture_optimization?.files?.[name]!==await hash(path.join(__dirname,name)))throw new Error('The VidCapture audio adapter changed during processing.');
      for(const [rel,want]of Object.entries(receipt.implementation_sha256||{})){if(rel.includes('..')||path.isAbsolute(rel)||await hash(path.join(this.folioRoot,rel))!==want)throw new Error('Folio implementation changed during processing.');}
      const audioProbe=await this.probe(enhanced);if(Number(audioProbe.streams[0].duration_ts)!==inputFrames)throw new Error('Folio changed the audio duration.');
      this.stage('Saving video with enhanced audio');
      const args=['-nostdin','-v','error','-i',file,'-i',enhanced];
      if(Number.isInteger(meta.systemTrack))args.push('-filter_complex',`[1:a:0][0:a:${meta.systemTrack}]amix=inputs=2:duration=longest:normalize=0[mix]`,'-map','0:v:0','-map','[mix]');
      else args.push('-map','0:v:0','-map','1:a:0');
      args.push('-c:v','copy','-c:a','aac','-b:a','192k','-movflags','+faststart','-n',pending);
      await this.process('ffmpeg',args);
      const result=await this.probe(pending);if(Math.abs(Number(result.format.duration)-info.duration)>0.15)throw new Error('Enhanced video failed its duration check.');
      this.stage('Finishing enhanced copy');
      await fs.rename(pending,output);
      await fs.writeFile(this.metadataPath(output),JSON.stringify({enhancedFrom:file,folioReceipt:receipt,micTrack:null,systemTrack:null,keep:carryKeep(info.keep,Number(result.format.duration))}),{mode:0o600});
      return output;
    }finally{await fs.rm(work,{recursive:true,force:true});}
  });}
}
module.exports={carryKeep,MediaTools,validKeep,editGraph,selectGraph,MAX_SECTIONS,hash,exportArgs,hardwareDecodable,intelRenderNode};
