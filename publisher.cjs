const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const os=require('node:os');
const {validKeep}=require('./media.cjs');
const {createThumbnail}=require('./thumbnail.cjs');
const {planKey,readMeta,updateMeta,validRecord}=require('./shares.cjs');
const {buildVTT}=require('./captions.cjs');
const ORIGIN='https://vidcapture.stream';
// The Worker records each part independently and verifies all of them on completion,
// so parts can travel concurrently and finish in any order.
const CONCURRENCY=5,PART_ATTEMPTS=4;
function wait(ms,signal){return new Promise((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);const stop=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);signal.addEventListener('abort',stop,{once:true});});}
// A request that never got an answer says what to do instead of "fetch failed".
// Cancels pass through unchanged so a paused upload still reads as paused.
function networkError(error,origin){
 const host=new URL(origin).host;
 if(error?.name==='TimeoutError')return new Error(`${host} is not responding. Try again shortly.`);
 if(error?.name==='TypeError')return new Error(`Could not reach ${host}. Check your internet connection and try again.`);
 return error;
}
class Publisher {
 constructor(recorder,media,options={}){this.rec=recorder;this.media=media;this.fixedOrigin=options.origin;this.origin=options.origin||ORIGIN;this.fetch=options.fetch||fetch;this.openExternal=options.openExternal;this.transcript=options.transcript||null;this.log=options.log||((...a)=>console.error(...a));this.pairInterval=options.pairInterval??2000;this.concurrency=Math.max(1,Math.min(16,Math.floor(options.concurrency||CONCURRENCY)));this.retryDelay=options.retryDelay??500;this.controller=null;this.configFile=path.join(recorder.dataDir,'publishing.json');this.checkpoints=path.join(recorder.dataDir,'uploads');}
 async init(){try{const c=await this.config();this.origin=c.origin;this.rec.state.publishingReady=true;}catch{this.rec.state.publishingReady=false;}}
 async config(){const c=JSON.parse(await fs.readFile(this.configFile,'utf8'));let origin;try{origin=new URL(c.origin);}catch{throw new Error('Publishing is not connected on this computer.');}if(!/^[a-f0-9]{64}$/.test(c.token)||origin.origin!==c.origin||origin.protocol!=='https:'||origin.username||origin.password||(this.fixedOrigin&&c.origin!==this.fixedOrigin))throw new Error('Publishing is not connected on this computer.');return c;}
 // Confirm the one-time migration without blocking local recording on network availability.
 async confirmUpdater(){return this.request('/api/admin/app-upgrade',{method:'POST'});}
 async request(route,options={}){
  const config=await this.config();if(config.origin!==this.origin)throw new Error('Sharing configuration changed. Restart VidCapture to reconnect.');const {signal,...rest}=options;signal?.throwIfAborted();this.controller?.signal.throwIfAborted();
  let response;try{response=await this.fetch(this.origin+route,{...rest,redirect:'error',headers:{...options.headers,Authorization:`Bearer ${config.token}`,'X-VidCapture-Updater':'1'},signal:AbortSignal.any([...(this.controller?[this.controller.signal]:[]),...(signal?[signal]:[]),AbortSignal.timeout(options.method==='PUT'?600000:120000)])});}catch(error){throw networkError(error,this.origin);}
  const bytes=await response.body?.getReader();let text='',size=0;const decoder=new TextDecoder();if(bytes){while(true){const {done,value}=await bytes.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await bytes.cancel();throw new Error('Invalid publishing response.');}text+=decoder.decode(value,{stream:true});}}
  text+=decoder.decode();let data;try{data=JSON.parse(text);}catch{throw new Error(`Publishing service returned ${response.status}. Try again shortly.`);}
  if(!response.ok)throw Object.assign(new Error(data.error||'Upload failed.'),{status:response.status});return data;
 }
 // Connects this computer to a vidcapture.stream account. The browser opens the site, the person
 // logs in or signs up and approves the matching code. The token stays here; the site keeps only its hash.
 async connect(signal){
  if(!this.openExternal)throw new Error('Publishing is not connected on this computer.');
  const token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(token).digest('hex'),host=new URL(this.origin).host;
  const post=async(route,body,auth)=>{
   let response;try{response=await this.fetch(this.origin+route,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body||{}),signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});}catch(error){throw networkError(error,this.origin);}
   let data={};try{data=await response.json();}catch{}
   if(!response.ok)throw Object.assign(new Error(data.error||`${host} returned ${response.status}. Try again shortly.`),{status:response.status});return data;
  };
  this.media.stage(`Opening ${host}`);
  const pair=await post('/api/pair/start',{hash,name:(os.hostname()||'').slice(0,60)||'VidCapture app'});
  if(typeof pair.url!=='string'||!pair.url.startsWith(this.origin+'/connect-app#')||typeof pair.code!=='string'||!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pair.code))throw new Error('Invalid connection response.');
  await this.openExternal(pair.url);
  this.media.stage(`Log in or sign up at ${host}, then type code ${pair.code}`);
  const until=Date.now()+20*60*1000;
  while(Date.now()<until){
   await wait(this.pairInterval,signal);
   let status;try{status=(await post('/api/pair/status',null,true)).status;}catch(error){if(signal.aborted||error.status&&error.status<500&&error.status!==429)throw error;continue;}
   if(status==='approved'){
    const tmp=this.configFile+'.tmp';await fs.writeFile(tmp,JSON.stringify({origin:this.origin,token}),{mode:0o600});await fs.rename(tmp,this.configFile);
    this.rec.set({publishingReady:true});this.media.stage('Connected');return;
   }
   if(status==='expired')break;
  }
  throw new Error('The connection request expired. Share again to get a new code.');
 }
 // Runs work that needs a connected account, connecting first or again when the site no longer knows this computer.
 async connected(work){
  let ready=true;try{await this.config();}catch{ready=false;}
  if(!ready)await this.connect(this.controller.signal);
  try{return await work();}
  catch(error){if(error.status!==401||!ready)throw error;await fs.rm(this.configFile,{force:true});this.rec.set({publishingReady:false});await this.connect(this.controller.signal);return work();}
 }
 async libraryURL(){const data=await this.request('/api/admin/browser-session',{method:'POST'});if(typeof data.url!=='string'||!data.url.startsWith(this.origin+'/connect#'))throw new Error('Invalid library link.');return data.url;}
 async uploadThumbnail(file,id){
  const work=await fs.mkdtemp(path.join(this.rec.dataDir,'.thumbnail-'));
  try{
   this.media.stage('Creating animated video card');
   const preview=await createThumbnail(this.media,file,work);
   for(const [kind,type] of [['gif','image/gif'],['poster','image/jpeg']]){
    const body=await fs.readFile(preview[kind]);
    for(let attempt=0;;attempt++){
     try{await this.request(`/api/admin/videos/${id}/${kind==='gif'?'thumbnail':'poster'}`,{method:'PUT',headers:{'Content-Type':type},body});break;}
     catch(error){if(this.media.cancelled||this.controller?.signal.aborted||attempt>=PART_ATTEMPTS-1||error.status&&error.status<500&&error.status!==429)throw error;await wait(this.retryDelay*2**attempt,this.controller?.signal||new AbortController().signal);}
    }
   }
  }finally{await fs.rm(work,{recursive:true,force:true});}
 }
 // Captions for the shared cut, from the original recording's transcript. Optional:
 // any failure is logged and the share goes on without them.
 async uploadCaptions(original,plan,duration,id){
  if(!this.transcript)return false;
  try{
   const t=(await this.transcript(original))?.transcript;
   if(!t||!Array.isArray(t.words)||!t.words.length)return false;
   const vtt=buildVTT(t.words,plan,duration);if(!vtt)return false;
   this.media.stage('Adding captions');
   await this.request(`/api/admin/videos/${id}/captions`,{method:'PUT',headers:{'Content-Type':'text/vtt'},body:Buffer.from(vtt)});
   return true;
  }catch(error){this.log('Captions were not uploaded:',error.message);return false;}
 }
 async card(){
  const share=this.rec.state.share;if(!share?.id)throw new Error('No share link is ready.');
  const video=await this.request(`/api/admin/videos/${share.id}`);
  if(!video.thumbnailReady)throw new Error('This video has no thumbnail yet. Open Online library to create its card.');
  return require('./share-card.cjs').shareCard(video,this.origin);
 }
 cancel(){this.controller?.abort();}
 // A recording already shared with the same edits keeps its link: no second upload.
 // A link removed online is forgotten, so the recording can be shared again.
 async existingLink(original,key,title){
  const saved=(await readMeta(this.rec.dataDir,original)).share;
  if(!validRecord(saved,this.origin)||saved.planKey!==key)return null;
  this.media.stage('Checking vidcapture.stream');
  let online=null;
  try{online=await this.request(`/api/admin/videos/${saved.id}`);}catch(error){if(error.status!==404)throw error;}
  if(!online||online.status==='deleted'){await updateMeta(this.rec.dataDir,original,m=>{delete m.share;});return null;}
  if(online.status!=='ready'||typeof online.url!=='string'||!online.url.startsWith(this.origin+'/v/'))return null;
  if(online.title!==title){try{online=await this.request(`/api/admin/videos/${saved.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})});}catch{}}
  await updateMeta(this.rec.dataDir,original,m=>{m.share={...saved,url:online.url,title:online.title};});
  this.rec.set({share:{url:online.url,title:online.title,file:original,id:saved.id,thumbnailReady:!!online.thumbnailReady,cardWarning:null,existing:true}});
  return original;
 }
 // Brings local share records in line with vidcapture.stream: links removed
 // online are cleared, titles refreshed, and uploads made before records
 // existed are matched to their files by size and modification time.
 async syncShares(){
  if(!this.rec.state.publishingReady)return {synced:false,changed:0};
  const data=await this.request('/api/admin/videos');
  const online=new Map((Array.isArray(data.videos)?data.videos:[]).map(v=>[v.id,v]));
  const dir=this.rec.dataDir,stats=new Map();let changed=0;
  for(const name of await fs.readdir(this.rec.outputDir).catch(()=>[])){
   if(name.startsWith('.')||!/\.(mp4|mkv)$/i.test(name)||name.endsWith('.saving.mp4'))continue;
   try{const st=await fs.stat(path.join(this.rec.outputDir,name));if(st.isFile())stats.set(name,st);}catch{}
  }
  for(const name of stats.keys()){
   const s=(await readMeta(dir,name)).share;if(!s||typeof s.id!=='string')continue;
   const v=online.get(s.id);
   if(!v||v.status==='deleted'){await updateMeta(dir,name,m=>{delete m.share;});changed++;}
   else if(v.url&&(v.url!==s.url||v.title!==s.title)){await updateMeta(dir,name,m=>{m.share={...m.share,url:v.url,title:v.title};});changed++;}
  }
  for(const entry of await fs.readdir(this.checkpoints).catch(()=>[])){
   if(!entry.endsWith('.json'))continue;
   let c;try{c=JSON.parse(await fs.readFile(path.join(this.checkpoints,entry),'utf8'));}catch{continue;}
   const v=c&&online.get(c.id);if(!v||v.status!=='ready'||typeof v.url!=='string'||!v.url.startsWith(this.origin+'/v/'))continue;
   const same=st=>st&&st.size===c.size&&Math.abs(st.mtimeMs-c.mtime)<=1;
   let name=path.basename(String(c.file||''));
   if(!same(stats.get(name)))name=[...stats].find(([,st])=>same(st))?.[0];
   if(!name||(await readMeta(dir,name)).share?.id)continue;
   // The checkpoint holds the exact file that was uploaded, so it is shared whole.
   const at=Number(v.publishedAt||v.createdAt);// seconds
   await updateMeta(dir,name,m=>{m.share={id:c.id,url:v.url,title:v.title,planKey:'full',duration:v.duration,sharedAt:Number.isFinite(at)&&at>0?new Date(at*1000).toISOString():null,uploaded:name};});changed++;
  }
  return {synced:true,changed};
 }
 // Uploads missing parts with a bounded pool. Each worker owns one reusable part buffer, so memory
 // stays near concurrency x 8 MiB. Any failure or pause aborts every request still in flight.
 async uploadParts(file,id,stat,chunkSize,completed){
  const total=Math.ceil(stat.size/chunkSize),queue=[];let sent=0,shown=-1,failure=null;
  for(let n=1;n<=total;n++){if(completed.has(n))sent+=Math.min(chunkSize,stat.size-(n-1)*chunkSize);else queue.push(n);}
  const progress=()=>{const percent=Math.floor(sent/stat.size*100);if(percent!==shown){shown=percent;this.media.stage(`Uploading ${percent}%`);}};
  progress();if(!queue.length)return;
  const pool=new AbortController(),signal=AbortSignal.any([this.controller.signal,pool.signal]),handle=await fs.open(file,'r');
  const worker=async()=>{
   const buffer=Buffer.allocUnsafe(Math.min(chunkSize,stat.size));
   while(queue.length){
    if(this.media.cancelled||signal.aborted)throw new Error('Upload paused.');
    const n=queue.shift(),offset=(n-1)*chunkSize,size=Math.min(chunkSize,stat.size-offset),body=buffer.subarray(0,size);
    const current=await handle.stat();if(current.size!==stat.size||current.mtimeMs!==stat.mtimeMs)throw new Error('The recording changed during upload.');
    let read=0;while(read<size){const part=await handle.read(body,read,size-read,offset+read);if(!part.bytesRead)throw new Error('The recording changed during upload.');read+=part.bytesRead;}
    for(let attempt=0;;attempt++){
     try{await this.request(`/api/admin/videos/${id}/parts/${n}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Length':String(size)},body,signal});break;}
     catch(error){if(this.media.cancelled||signal.aborted||attempt>=PART_ATTEMPTS-1||error.status&&error.status<500&&error.status!==429)throw error;await wait(this.retryDelay*2**attempt*(1+Math.random()/2),signal);}
    }
    sent+=size;progress();
   }
  };
  try{await Promise.allSettled(Array.from({length:Math.min(this.concurrency,queue.length)},()=>worker().catch(error=>{failure??=error;pool.abort();})));}
  finally{await handle.close();}
  if(failure)throw failure;
 }
 publish(file,title,keep){
  if(typeof title!=='string'||!title.trim()||title.trim().length>160)throw new Error('Enter a title between 1 and 160 characters.');
  return this.media.startJob('publish','Preparing your video',async()=>{
   this.controller=new AbortController();this.rec.set({share:null});
   try{
    file=await this.rec.allowedFile(file);const original=file,info=await this.media.getMedia(file),metadata=await this.media.metadata(file);if(metadata.keep!==undefined)validKeep(metadata.keep,info.duration);const plan=validKeep(keep||info.keep,info.duration),stat=await fs.stat(file);
    // Size, time and edits identify the upload; the path is left out so a renamed recording still resumes.
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([stat.size,stat.mtimeMs,plan])).digest('hex');
    const key=planKey(plan,info.duration),trimmed=title.trim();
    const linked=await this.connected(()=>this.existingLink(original,key,trimmed));if(linked)return linked;
    await fs.mkdir(this.checkpoints,{recursive:true,mode:0o700});const checkpoint=path.join(this.checkpoints,fingerprint+'.json');let saved;
    try{saved=JSON.parse(await fs.readFile(checkpoint,'utf8'));}catch{}
    const cut=plan.length!==1||plan[0][0]!==0||Math.abs(plan[0][1]-info.duration)>.01;
    if(saved?.file){try{file=await this.rec.allowedFile(saved.file);const cached=await fs.stat(file);if(cached.size!==saved.size||cached.mtimeMs!==saved.mtime)throw new Error('Cached upload changed.');}catch{saved=null;file=original;}}
    if(cut&&!saved){this.media.stage('Saving your cuts before uploading');file=await this.media.createEditedCopy(original,plan);}
    if(this.media.cancelled)throw new Error('Upload paused.');
    const current=await this.media.getMedia(file),fileStat=await fs.stat(file),probe=await this.media.probe(file);
    if(!/\.mp4$/i.test(file)||probe.streams.find(s=>s.codec_type==='video')?.codec_name!=='h264')throw new Error('Sharing needs an H.264 MP4. Save an edited MP4 copy first.');
    let id=saved?.id||crypto.randomUUID();saved={id,file,original,size:fileStat.size,mtime:fileStat.mtimeMs};
    await fs.writeFile(checkpoint+'.tmp',JSON.stringify(saved),{mode:0o600});await fs.rename(checkpoint+'.tmp',checkpoint);
    this.media.stage('Connecting to vidcapture.stream');
    const initiate=()=>this.request('/api/admin/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,title:title.trim(),size:fileStat.size,duration:current.duration,width:current.width,height:current.height})});
    let upload;try{upload=await this.connected(initiate);}catch(error){if(error.status!==410)throw error;id=crypto.randomUUID();saved.id=id;await fs.writeFile(checkpoint+'.tmp',JSON.stringify(saved),{mode:0o600});await fs.rename(checkpoint+'.tmp',checkpoint);upload=await initiate();}
    let result=upload,thumbnailReady=!!upload.thumbnailReady,cardWarning=null;
    const prepareCard=async()=>{
     try{await this.uploadThumbnail(file,id);thumbnailReady=true;}
     catch(error){if(this.media.cancelled||this.controller.signal.aborted)throw error;cardWarning='Video ready. The preview could not be created. Open Online library to try the card again.';}
    };
    if(upload.status!=='ready'){
     if(upload.chunkSize!==8*1024*1024||!Array.isArray(upload.parts))throw new Error('Invalid upload settings.');
     await this.uploadParts(file,id,fileStat,upload.chunkSize,new Set(upload.parts.map(p=>p.partNumber)));
     const after=await fs.stat(file);if(after.size!==fileStat.size||after.mtimeMs!==fileStat.mtimeMs)throw new Error('The recording changed during upload.');
     if(!thumbnailReady)await prepareCard();
     this.media.stage('Finishing your share link');result=await this.request(`/api/admin/videos/${id}/complete`,{method:'POST'});
    }
    if(typeof result.url!=='string'||!new RegExp('^'+this.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/v/[a-f0-9]{48}$').test(result.url))throw new Error('Publishing did not return a valid link.');
    if(upload.status==='ready'&&!thumbnailReady)await prepareCard();
    await this.uploadCaptions(original,plan,info.duration,id);
    const record={id,url:result.url,title:result.title,sharedAt:new Date().toISOString()};
    await updateMeta(this.rec.dataDir,original,m=>{m.share={...record,planKey:key,duration:info.duration,uploaded:path.basename(file)};});
    if(file!==original)await updateMeta(this.rec.dataDir,file,m=>{m.share={...record,planKey:'full',duration:current.duration,uploaded:path.basename(file)};});
    this.rec.set({share:{url:result.url,title:result.title,file,id,thumbnailReady,cardWarning}});return file;
   }catch(error){if(this.controller.signal.aborted||this.media.cancelled)throw new Error('Upload paused. Share this recording again to resume.');throw error;}
   finally{this.controller=null;}
  });
 }
}
module.exports={Publisher,ORIGIN,networkError};
