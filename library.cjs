// Local recordings library: lists every recording in the output folder with a
// readable title, duration, and a small poster frame. Posters and durations are
// cached in <dataDir>/thumbs, keyed by file name, size, and modification time,
// so a changed or replaced recording gets a fresh poster.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {shareView,updateMeta}=require('./shares.cjs');
const {promisify}=require('node:util');
const execRun=promisify(execFile);

const RECORDING_RE=/^[^.].*\.(mp4|mkv)$/i;
const STAMP_RE=/^Capture-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/;
// Titled recordings: "<AI title> YYYY-MM-DD HH.MM" in local time, " 2" on collisions.
const TITLED_RE=/^(.+?) (\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})(?: \d{1,2})?(?=$|-|\.(?:mp4|mkv)$)/i;
const THUMB_RE=/^[a-f0-9]{40}\.jpg$/;
// Edits and audio passes save copies named <original stem>-edited-<ms>, and so on.
const VERSION_RE=/-(?:edited|enhanced|quick-studio|folio)-\d{10,}/;

// The original recording's stem for any version of it.
function versionBase(name){
  const stem=path.basename(String(name),path.extname(String(name)));
  const m=stem.match(VERSION_RE);
  return m?stem.slice(0,m.index):stem;
}

// Collapses copies of one recording into a single entry with its versions,
// newest first. The current version is the newest, unless the person restored
// an older one and nothing newer has been made since.
function groupVersions(items,metas=new Map(),origin=null){
  const groups=new Map();
  for(const item of items){const base=versionBase(item.name);if(!groups.has(base))groups.set(base,[]);groups.get(base).push(item);}
  const out=[];
  for(const [base,list] of groups){
    list.sort((a,b)=>b.modified.localeCompare(a.modified)||b.name.length-a.name.length);
    const original=list.find(i=>path.basename(i.name,path.extname(i.name))===base)||list[list.length-1];
    const pick=metas.get(original.name)?.currentVersion;
    let current=list[0];
    if(pick&&typeof pick.suffix==='string'&&Number.isFinite(pick.at)){
      const chosen=list.find(i=>i.name===base+pick.suffix);
      if(chosen&&!list.some(i=>i!==chosen&&Date.parse(i.modified)>pick.at))current=chosen;
    }
    out.push({...current,title:original.title,dated:original.dated,recordedAt:original.recordedAt||current.recordedAt,root:original.name,
      versions:list.map(v=>({name:v.name,path:v.path,key:v.key,variant:v.variant,label:v===original?'Original':(v.variant||'Copy'),modified:v.modified,bytes:v.bytes,
        duration:v.duration,poster:v.poster,unreadable:v.unreadable,current:v===current,original:v===original,share:origin?shareView(metas.get(v.name),origin):null}))});
  }
  return out;
}
const VARIANTS=[['edited','Edited'],['enhanced','Enhanced audio'],['quick-studio','Enhanced audio'],['folio','Enhanced audio']];

function isRecordingName(name){
  return typeof name==='string'&&path.basename(name)===name&&RECORDING_RE.test(name)&&!name.endsWith('.saving.mp4');
}

// The recorder names files Capture-<UTC ISO time with : and . replaced>.mkv;
// once titled they become "<title> YYYY-MM-DD HH.MM.mp4". Edits append
// -edited-<ms>, -enhanced-<ms>, and similar.
function parseRecordingName(name){
  const n=String(name);
  let m=n.match(STAMP_RE),recordedAt=null,title=null;
  if(m){
    const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6],+(m[7]||0)));
    if(!Number.isNaN(d.getTime())&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3])recordedAt=d;
  }else if((m=n.match(TITLED_RE))){
    const d=new Date(+m[2],+m[3]-1,+m[4],+m[5],+m[6]);
    if(!Number.isNaN(d.getTime())&&d.getMonth()===+m[3]-1&&d.getDate()===+m[4])recordedAt=d;
    title=m[1].trim();
  }
  const rest=m?n.slice(m[0].length):'';
  const labels=[];
  for(const [token,label] of VARIANTS)if(new RegExp(`-${token}-\\d+`).test(rest)&&!labels.includes(label))labels.push(label);
  return {recordedAt,title,variant:labels.length?labels.map((l,i)=>i?l.toLowerCase():l).join(', '):null};
}

function formatTitle(date,{now=new Date(),timeZone}={}){
  const opts={month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone};
  const year=d=>new Intl.DateTimeFormat('en-US',{year:'numeric',timeZone}).format(d);
  if(year(date)!==year(now))opts.year='numeric';
  // en-US joins date and time with ", " or " at " depending on the runtime; normalize.
  return new Intl.DateTimeFormat('en-US',opts).format(date).replace(' at ',', ').replace(/ /g,' ');
}

// Card title: the AI title from the sidecar or the file name, else the date.
function recordingTitle(name,options={},meta=null){
  const parsed=parseRecordingName(name);
  let recordedAt=parsed.recordedAt;
  const saved=meta&&typeof meta.recordedAt==='string'?new Date(meta.recordedAt):null;
  if(saved&&!Number.isNaN(saved.getTime())&&(!recordedAt||parsed.title))recordedAt=saved;
  const named=meta&&typeof meta.title==='string'&&meta.title.trim()?meta.title.trim():parsed.title;
  const title=named||(recordedAt?formatTitle(recordedAt,options):path.basename(name,path.extname(name)).replace(/^Capture-/,'')||name);
  return {title,dated:!named&&!!recordedAt,variant:parsed.variant,recordedAt:recordedAt?recordedAt.toISOString():null};
}

function cacheKey(name,size,mtimeMs){
  return crypto.createHash('sha1').update(JSON.stringify([name,size,Math.round(mtimeMs)])).digest('hex');
}

// Resolves a requested poster name to a file inside the cache folder, or throws.
async function thumbPath(dir,name){
  if(typeof name!=='string'||!THUMB_RE.test(name))throw new Error('Invalid poster.');
  const file=path.join(dir,name);
  const real=await fs.realpath(file);
  if(path.dirname(real)!==await fs.realpath(dir))throw new Error('Poster is outside the cache.');
  const stat=await fs.lstat(real);if(!stat.isFile())throw new Error('Invalid poster.');
  return real;
}

class Library{
  constructor(recorder,{run=execRun,concurrency=2,now,origin=null}={}){
    this.rec=recorder;this.run=run;this.concurrency=concurrency;this.now=now;
    // Share links are only shown for this site; a function so a reconnect is seen.
    this.origin=typeof origin==='function'?origin:()=>origin;
    this.dir=path.join(recorder.dataDir,'thumbs');
    this.inflight=new Map();this.failed=new Map();this.queue=[];this.active=0;
  }
  async ensureDir(){await fs.mkdir(this.dir,{recursive:true,mode:0o700});await fs.chmod(this.dir,0o700).catch(()=>{});}
  async list(){
    await this.ensureDir();
    const items=[],keys=new Set();
    let names=[];try{names=await fs.readdir(this.rec.outputDir);}catch{return [];}
    const metas=new Map();
    for(const name of names){
      if(!isRecordingName(name))continue;
      const file=path.join(this.rec.outputDir,name);
      if(file===this.rec.rawFile)continue;
      let stat;try{stat=await fs.stat(file);}catch{continue;}
      if(!stat.isFile()||stat.size<=0)continue;
      const key=cacheKey(name,stat.size,stat.mtimeMs);keys.add(key);
      const info=await this.readInfo(key);
      let meta=null;try{meta=JSON.parse(await fs.readFile(path.join(this.rec.dataDir,name+'.json'),'utf8'));}catch{}
      if(meta)metas.set(name,meta);
      items.push({path:file,name,bytes:stat.size,modified:stat.mtime.toISOString(),key,...recordingTitle(name,{now:this.now?.()},meta),
        duration:info?.duration??null,poster:info?.poster?`capture-media://thumb/${key}.jpg`:null,unreadable:this.failed.has(key)});
    }
    this.prune(keys).catch(()=>{});
    // Newest recording first.
    const when=i=>i.recordedAt||i.modified;
    return groupVersions(items,metas,this.origin()).sort((a,b)=>when(b).localeCompare(when(a))||b.modified.localeCompare(a.modified)||b.name.localeCompare(a.name));
  }
  async readInfo(key){try{return JSON.parse(await fs.readFile(path.join(this.dir,key+'.json'),'utf8'));}catch{return null;}}
  async prune(keep){
    for(const name of await fs.readdir(this.dir)){
      const m=name.match(/^([a-f0-9]{40})\.(jpg|json)$/);
      if(m&&!keep.has(m[1]))await fs.rm(path.join(this.dir,name),{force:true});
    }
  }
  // Makes one version the one the Library shows, edits and shares. Nothing is deleted.
  async setCurrentVersion(root,name){
    if(!isRecordingName(root)||!isRecordingName(name))throw new Error('Choose a file from your Capture recordings.');
    const base=versionBase(root);
    if(versionBase(name)!==base)throw new Error('That is not a version of this recording.');
    await this.rec.allowedFile(path.join(this.rec.outputDir,root));
    await this.rec.allowedFile(path.join(this.rec.outputDir,name));
    const file=path.join(this.rec.dataDir,root+'.json');
    let meta={};try{meta=JSON.parse(await fs.readFile(file,'utf8'));}catch{}
    meta.currentVersion={suffix:name.slice(base.length),at:Date.now()};
    await fs.writeFile(file+'.tmp',JSON.stringify(meta),{mode:0o600});await fs.rename(file+'.tmp',file);
    return this.list();
  }
  // Every file of one recording: the original and its edited and enhanced copies.
  async versionFiles(root){
    if(!isRecordingName(root))throw new Error('Choose a file from your Capture recordings.');
    await this.rec.allowedFile(path.join(this.rec.outputDir,root));
    const base=versionBase(root),out=[];
    for(const name of await fs.readdir(this.rec.outputDir).catch(()=>[])){
      if(!isRecordingName(name)||versionBase(name)!==base)continue;
      const file=path.join(this.rec.outputDir,name);
      if(file===this.rec.rawFile)continue;
      out.push(await this.rec.allowedFile(file));
    }
    return out;
  }
  // The title shown everywhere for a recording. It is kept in the original's
  // sidecar; a recording still named Capture-<time> is renamed to match later.
  async rename(root,title){
    const clean=String(title??'').replace(/[\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim();
    if(!clean)throw new Error('Enter a name.');
    if(clean.length>120)throw new Error('Use a name up to 120 characters.');
    await this.versionFiles(root);
    await updateMeta(this.rec.dataDir,root,m=>{m.title=clean;});
    return this.list();
  }
  // Moves every version of a recording to the Trash, so a mistake can be undone there.
  async remove(root,trash){
    if(['starting','recording','paused','stopping'].includes(this.rec.state.phase))throw new Error('Finish recording first.');
    if(this.rec.state.job?.running)throw new Error('Wait for the current job to finish.');
    const files=await this.versionFiles(root);
    for(const file of files)await trash(file);
    await this.rec.refreshRecent?.();
    return this.list();
  }
  // Returns {duration, poster, unreadable} for one recording, creating the poster if needed.
  async details(name){
    if(!isRecordingName(name))throw new Error('Choose a file from your Capture recordings.');
    const file=await this.rec.allowedFile(path.join(this.rec.outputDir,name));
    const stat=await fs.stat(file);const key=cacheKey(name,stat.size,stat.mtimeMs);
    await this.ensureDir();
    const cached=await this.readInfo(key);
    if(cached?.poster&&await fs.access(path.join(this.dir,key+'.jpg')).then(()=>true,()=>false))return this.result(key,cached);
    if(this.failed.has(key))return {key,duration:this.failed.get(key).duration??null,poster:null,unreadable:true};
    if(!this.inflight.has(key))this.inflight.set(key,this.schedule(()=>this.generate(file,key)).finally(()=>this.inflight.delete(key)));
    return this.inflight.get(key);
  }
  result(key,info){return {key,duration:info.duration??null,poster:info.poster?`capture-media://thumb/${key}.jpg`:null,unreadable:false};}
  schedule(task){
    return new Promise((resolve,reject)=>{this.queue.push({task,resolve,reject});this.pump();});
  }
  pump(){
    while(this.active<this.concurrency&&this.queue.length){
      const {task,resolve,reject}=this.queue.shift();this.active++;
      Promise.resolve().then(task).then(resolve,reject).finally(()=>{this.active--;this.pump();});
    }
  }
  async generate(file,key){
    let duration=null;
    try{
      const {stdout}=await this.run('ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{timeout:15000});
      const d=Number(JSON.parse(stdout).format?.duration);if(Number.isFinite(d)&&d>0)duration=d;
    }catch{}
    const out=path.join(this.dir,key+'.jpg'),tmp=path.join(this.dir,`${key}.${process.pid}.tmp.jpg`);
    // Input seeking reads only around the chosen frame, never the whole file.
    const at=duration?Math.min(1,duration*0.1):0;
    try{
      await this.run('ffmpeg',['-nostdin','-v','error','-threads','1','-ss',at.toFixed(2),'-i',file,'-frames:v','1','-an','-vf','scale=480:-2','-q:v','5','-y',tmp],{timeout:20000});
      await fs.chmod(tmp,0o600);await fs.rename(tmp,out);
    }catch{
      await fs.rm(tmp,{force:true});
      this.failed.set(key,{duration});
      return {key,duration,poster:null,unreadable:true};
    }
    const info={duration,poster:true};
    await fs.writeFile(path.join(this.dir,key+'.json'),JSON.stringify(info),{mode:0o600});
    return this.result(key,info);
  }
  async serve(url){
    try{
      const name=decodeURIComponent(url.pathname.slice(1));
      const file=await thumbPath(this.dir,name);
      const body=await fs.readFile(file);
      return new Response(body,{status:200,headers:{'Content-Type':'image/jpeg','Content-Length':String(body.length),'Cache-Control':'no-store'}});
    }catch{return new Response('',{status:404});}
  }
}

module.exports={Library,versionBase,groupVersions,isRecordingName,parseRecordingName,formatTitle,recordingTitle,cacheKey,thumbPath};
