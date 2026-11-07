'use strict';
// Word-timed transcripts for the editor. Speech recognition runs locally with
// Parakeet (scripts/setup-transcription.sh, or a Narration Studio install). An optional, light Claude Haiku pass
// only adds punctuation and capitalization: every word, including um and uh,
// must come back unchanged and in order, or that section keeps Parakeet's text.
const fs=require('node:fs/promises');
const path=require('node:path');
const {speechRuntime}=require('./speech-runtime.cjs');
const os=require('node:os');
const {spawn}=require('node:child_process');

const SCHEMA='vidcapture-transcript/1';
const FILLERS=new Set(['um','umm','ummm','uh','uhh','uhm','erm','er','ah','ahh','hmm','hm','mm','mhm']);
const POLISH_PROMPT='You add punctuation and capitalization to a verbatim speech transcript. Output only the transcript. Keep every word exactly, in order, including um, uh, repeated words, false starts and filler. Never add, remove, merge, split, reorder, correct or replace words. You may only change punctuation attached to words and the capitalization of letters. Keep the same number of space-separated words.';
const CHUNK_WORDS=450;

// Compares words ignoring punctuation and case, which is all the polish pass may change.
function normWord(w){return String(w).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');}
const isFiller=w=>FILLERS.has(normWord(w).replace(/'/g,''));

// Splits word indexes into chunks that end at a sentence when one is near.
function chunkRanges(words,size=CHUNK_WORDS){
  const out=[];let a=0;
  while(a<words.length){
    let b=Math.min(words.length,a+size);
    if(b<words.length){
      for(let k=b;k>a+size*0.6;k--)if(/[.?!]$/.test(words[k-1].text)){b=k;break;}
    }
    out.push([a,b]);a=b;
  }
  return out;
}

// Returns the polished words when they match the originals word for word, else null.
function acceptPolish(original,text){
  const next=String(text||'').trim().split(/\s+/).filter(Boolean);
  if(next.length!==original.length)return null;
  for(let i=0;i<next.length;i++)if(normWord(next[i])!==normWord(original[i])||!normWord(next[i])&&next[i]!==original[i])return null;
  return next;
}

function validTranscript(t,duration){
  if(!t||t.schema!==SCHEMA||!Array.isArray(t.words))return false;
  let last=-1;
  for(const w of t.words){
    if(!w||typeof w.text!=='string'||!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start||w.start<last-0.001)return false;
    if(duration&&w.end>duration+0.1)return false;
    if(w.cut!==undefined&&!(Array.isArray(w.cut)&&w.cut.length===2&&w.cut.every(Number.isFinite)&&w.cut[1]>w.cut[0]))return false;
    last=w.start;
  }
  return true;
}

class Transcripts{
  constructor(recorder,media,options={}){
    this.rec=recorder;this.media=media;this.job=null;
    const speech=speechRuntime();
    this.python=options.python||speech.python;this.tool=options.tool||speech.tool;this.model=options.model||speech.model;
    this.claude=options.claude||process.env.CAPTURE_POLISH_CLAUDE||'claude';
    this.polishModel=options.polishModel||process.env.CAPTURE_POLISH_MODEL||'claude-haiku-5-5';
    this.polishEnabled=options.polish??process.env.CAPTURE_POLISH!=='off';
    // Called after a transcript is saved, for example to title the recording.
    this.onDone=typeof options.onDone==='function'?options.onDone:null;
    this.rec.state.transcriptJob=null;
  }
  file(source){return path.join(this.rec.dataDir,path.basename(source)+'.transcript.json');}
  async ready(){
    try{await fs.access(this.python);await fs.access(this.tool);await fs.access(this.model);return true;}catch{return false;}
  }
  async get(source){
    source=await this.rec.allowedFile(source);
    const stat=await fs.stat(source);
    let t;try{t=JSON.parse(await fs.readFile(this.file(source),'utf8'));}
    catch{
      // An enhanced copy borrows its source's transcript when that one is ready.
      if(await this.carry(source).catch(()=>false))return this.get(source);
      return {transcript:null,available:await this.ready()};
    }
    // A changed file needs a new transcript; its timings would no longer line up.
    if(!validTranscript(t)||t.sourceSize!==stat.size||Math.abs(t.sourceMtime-stat.mtimeMs)>1)return {transcript:null,available:await this.ready(),stale:true};
    return {transcript:t,available:true};
  }
  // Enhanced audio keeps every word at the same time, so an enhanced copy
  // reuses its source's transcript instead of transcribing again.
  async carry(copy){
    copy=await this.rec.allowedFile(copy);
    const from=(await this.media.metadata(copy)).enhancedFrom;if(typeof from!=='string')return false;
    let t;try{t=JSON.parse(await fs.readFile(this.file(from),'utf8'));}catch{return false;}
    const src=await fs.stat(from).catch(()=>null);
    if(!validTranscript(t)||!src||t.sourceSize!==src.size||Math.abs(t.sourceMtime-src.mtimeMs)>1)return false;
    const dest=this.file(copy);
    if(await fs.access(dest).then(()=>true,()=>false))return false;
    const stat=await fs.stat(copy);
    const out={...t,source:path.basename(copy),sourceSize:stat.size,sourceMtime:stat.mtimeMs,carriedFrom:path.basename(from)};
    await fs.writeFile(dest+'.tmp',JSON.stringify(out),{mode:0o600});await fs.rename(dest+'.tmp',dest);
    return true;
  }
  async carryToCopies(source){
    const dir=path.dirname(source);
    for(const name of await fs.readdir(this.rec.dataDir)){
      if(!name.endsWith('.json')||name.endsWith('.transcript.json'))continue;
      const copy=path.join(dir,name.slice(0,-5));
      if(!/\.(mp4|mkv)$/i.test(copy))continue;
      if((await this.media.metadata(copy)).enhancedFrom===source)await this.carry(copy).catch(()=>{});
    }
  }
  setJob(job){this.job=job;this.rec.set({transcriptJob:job?{file:job.file,stage:job.stage,percent:job.percent,error:job.error||null}:null});}
  update(fields){if(!this.job)return;Object.assign(this.job,fields);this.setJob(this.job);}
  cancel(){
    const job=this.job;if(!job)return false;
    job.cancelled=true;for(const child of job.children)child.kill('SIGTERM');
    return true;
  }
  spawnChild(job,cmd,args,{input,cwd,onLine,timeout=0}={}){
    return new Promise((resolve,reject)=>{
      if(job.cancelled)return reject(new Error('Transcript canceled.'));
      const child=spawn(cmd,args,{cwd,stdio:[input===undefined?'ignore':'pipe','pipe','pipe'],env:{...process.env,HF_HUB_OFFLINE:'1'}});
      job.children.add(child);
      let out='',err='',buf='';const timer=timeout?setTimeout(()=>child.kill('SIGKILL'),timeout):null;
      child.stdout.on('data',b=>{out+=b;if(onLine){buf+=b;const lines=buf.split('\n');buf=lines.pop();lines.forEach(onLine);}});
      child.stderr.on('data',b=>{err=(err+b).slice(-4000);});
      child.once('error',e=>{clearTimeout(timer);job.children.delete(child);reject(e);});
      child.once('close',code=>{clearTimeout(timer);job.children.delete(child);
        if(job.cancelled)return reject(new Error('Transcript canceled.'));
        code===0?resolve(out):reject(new Error(err.trim().split('\n').pop()||`${path.basename(cmd)} exited with ${code}`));});
      if(input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(input);}
    });
  }
  async polishChunk(job,words,cwd){
    const original=words.map(w=>w.text);
    const raw=await this.spawnChild(job,this.claude,['-p','--model',this.polishModel,'--tools','','--no-session-persistence','--disable-slash-commands','--strict-mcp-config','--setting-sources','','--system-prompt',POLISH_PROMPT,'--output-format','json'],{input:original.join(' '),cwd,timeout:180000});
    let result;try{result=JSON.parse(raw);}catch{return null;}
    if(result.is_error)return null;
    return acceptPolish(original,result.result);
  }
  async create(source){
    source=await this.rec.allowedFile(source);
    if(this.job)throw new Error('A transcript is already being made. Wait for it or cancel it first.');
    if(!(await this.ready()))throw new Error('Transcription is not installed. Run scripts/setup-transcription.sh.');
    const job={file:source,stage:'audio',percent:0,children:new Set(),cancelled:false};this.setJob(job);
    const work=await fs.mkdtemp(path.join(os.tmpdir(),'vidcapture-transcript-'));
    try{
      const before=await fs.stat(source);
      const info=await this.media.getMedia(source);
      if(!info.hasAudio)throw new Error('This recording has no audio to transcribe.');
      const meta=await this.media.metadata(source);
      const probe=await this.media.probe(source);const audioCount=probe.streams.filter(s=>s.codec_type==='audio').length;
      // The isolated microphone track gives the cleanest words; the mix is the fallback.
      const track=Number.isInteger(meta.micTrack)&&meta.micTrack>=0&&meta.micTrack<audioCount?meta.micTrack:0;
      const wav=path.join(work,'speech.wav'),out=path.join(work,'words.json');
      await this.spawnChild(job,'ffmpeg',['-nostdin','-v','error','-i',source,'-map',`0:a:${track}`,'-vn','-af','aresample=async=1:first_pts=0','-ac','1','-ar','16000','-y',wav]);
      this.update({stage:'words',percent:0});
      await this.spawnChild(job,this.python,[this.tool,'--input',wav,'--output',out,'--model',this.model,'--engine','parakeet','--device','cpu'],{cwd:work,onLine:line=>{
        const m=line.match(/Transcribed ([\d.]+) \/ ([\d.]+)s/);if(m&&+m[2]>0)this.update({percent:Math.min(99,Math.round(+m[1]/+m[2]*100))});
      }});
      const parsed=JSON.parse(await fs.readFile(out,'utf8'));
      const usable=(parsed.words||[]).filter(w=>typeof w.word==='string'&&w.word.trim()&&Number.isFinite(w.start)&&Number.isFinite(w.end));
      if(!usable.length)throw new Error('No speech was recognized in this recording.');
      // Reported word ends run early; cut points come from quiet moments in the audio.
      let cuts=null;
      try{
        await fs.writeFile(out,JSON.stringify({words:usable}));
        const bounds=path.join(work,'bounds.json');
        await this.spawnChild(job,this.python,[path.join(__dirname,'capture_word_bounds.py'),'--audio',wav,'--words',out,'--output',bounds],{cwd:work,timeout:300000});
        cuts=JSON.parse(await fs.readFile(bounds,'utf8'));if(!Array.isArray(cuts)||cuts.length!==usable.length)cuts=null;
      }catch(e){if(job.cancelled)throw e;cuts=null;}
      const r3=v=>Math.round(v*1000)/1000;
      const words=usable.map((w,i)=>{
        const word={text:w.word.trim(),start:r3(w.start),end:r3(Math.min(w.end,info.duration))};
        const c=cuts&&cuts[i];
        if(Array.isArray(c)&&c.every(Number.isFinite)&&c[0]>=0&&c[1]>c[0]&&c[1]<=info.duration+0.05)word.cut=[r3(c[0]),r3(Math.min(c[1],info.duration))];
        return word;
      });
      let polished=0,ranges=chunkRanges(words),polish='off';
      if(this.polishEnabled){
        this.update({stage:'polish',percent:0});polish='partial';let done=0,next=0;
        const worker=async()=>{
          while(next<ranges.length&&!job.cancelled){
            const [a,b]=ranges[next++];
            let accepted=null;try{accepted=await this.polishChunk(job,words.slice(a,b),work);}catch(e){if(job.cancelled)throw e;}
            if(accepted){accepted.forEach((t,i)=>{words[a+i].text=t;});polished++;}
            this.update({percent:Math.round(++done/ranges.length*100)});
          }
        };
        await Promise.all([worker(),worker(),worker()]);
        if(job.cancelled)throw new Error('Transcript canceled.');
        polish=polished===ranges.length?'complete':polished?'partial':'unavailable';
      }
      const after=await fs.stat(source);
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('The recording changed while it was being transcribed. Try again.');
      const transcript={schema:SCHEMA,source:path.basename(source),sourceSize:after.size,sourceMtime:after.mtimeMs,duration:info.duration,track,
        model:'parakeet-tdt-0.6b-v3-int8',polish,polishModel:polish==='off'?null:this.polishModel,polishedSections:polished,sections:ranges.length,
        createdAt:new Date().toISOString(),words};
      const dest=this.file(source);
      await fs.writeFile(dest+'.tmp',JSON.stringify(transcript),{mode:0o600});await fs.rename(dest+'.tmp',dest);
      this.setJob(null);
      // Enhanced copies made while this ran share its timeline.
      this.carryToCopies(source).catch(()=>{});
      if(this.onDone)Promise.resolve().then(()=>this.onDone(source,transcript)).catch(()=>{});
      return transcript;
    }catch(error){
      const message=job.cancelled?'Transcript canceled.':error.message;
      this.setJob(null);
      if(!job.cancelled)this.rec.set({transcriptJob:{file:source,stage:'failed',percent:0,error:message}});
      throw new Error(message);
    }finally{
      await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
    }
  }
  dispose(){this.cancel();}
}

module.exports={Transcripts,normWord,isFiller,chunkRanges,acceptPolish,validTranscript,FILLERS};
