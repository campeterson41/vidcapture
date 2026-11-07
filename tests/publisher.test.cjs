const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Publisher,ORIGIN}=require('../publisher.cjs');
const CHUNK=8*1024*1024,TOKEN='a'.repeat(64),SHARE='b'.repeat(48);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// A sparse fixture whose parts each start with their own part number, so misplaced bytes are detected.
async function fixture(parts,tail=12345){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-publish-test-'));
  const dataDir=path.join(root,'state'),videos=path.join(root,'videos');await fs.mkdir(dataDir);await fs.mkdir(videos);
  await fs.writeFile(path.join(dataDir,'publishing.json'),JSON.stringify({token:TOKEN,origin:ORIGIN}),{mode:0o600});
  const file=path.join(videos,'Capture-fixture.mp4'),size=(parts-1)*CHUNK+tail,handle=await fs.open(file,'w');
  for(let n=1;n<=parts;n++)await handle.write(Buffer.from([n,0xee]),0,2,(n-1)*CHUNK);
  await handle.truncate(size);await handle.close();
  const rec={dataDir,state:{},set(o){Object.assign(this.state,o);},allowedFile:async f=>f};
  const media={cancelled:false,stages:[],task:null,
    startJob(kind,stage,work){this.task=work().then(output=>({output}),error=>({error}));return {};},
    stage(s){if(this.cancelled)throw new Error('Processing canceled.');this.stages.push(s);},
    getMedia:async()=>({duration:60,width:1920,height:1080,keep:[[0,60]]}),metadata:async()=>({}),
    probe:async()=>({streams:[{codec_type:'video',codec_name:'h264'}]})};
  return {root,file,size,rec,media,parts};
}
// Fake vidcapture.stream service. Options control already stored parts, failures and response timing.
function service(size,{stored=[],fail=()=>null,latency=()=>5,preview=true}={}){
  const s={parts:new Map(stored.map(n=>[n,true])),puts:[],inFlight:0,maxInFlight:0,aborted:0,completed:0,signals:[],
    fetch:async(url,options)=>{
      assert.equal(options.headers.Authorization,`Bearer ${TOKEN}`);assert.equal(options.redirect,'error');
      const route=url.slice(ORIGIN.length),json=(data,status=200)=>new Response(JSON.stringify(data),{status});
      if(route==='/api/admin/uploads'){const body=JSON.parse(options.body);assert.equal(body.size,size);s.id=body.id;return json({status:'uploading',thumbnailReady:preview,chunkSize:CHUNK,parts:[...s.parts.keys()].map(partNumber=>({partNumber}))});}
      const part=/^\/api\/admin\/videos\/([a-f0-9-]{36})\/parts\/(\d+)$/.exec(route);
      if(part){
        const n=Number(part[2]),expected=Math.min(CHUNK,size-(n-1)*CHUNK);s.puts.push(n);s.signals.push(options.signal);
        assert.equal(part[1],s.id);assert.equal(Number(options.headers['Content-Length']),expected);assert.equal(options.body.length,expected);
        assert.equal(options.body[0],n,`part ${n} carries its own bytes`);
        s.inFlight++;s.maxInFlight=Math.max(s.maxInFlight,s.inFlight);
        try{
          await new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(t);s.aborted++;reject(options.signal.reason);};const t=setTimeout(()=>{options.signal.removeEventListener('abort',abort);resolve();},latency(n));options.signal.addEventListener('abort',abort,{once:true});});
          const failure=fail(n);if(failure)return json({error:failure.error||'Temporary failure.'},failure.status);
          s.parts.set(n,true);return json({partNumber:n,etag:'e'+n});
        }finally{s.inFlight--;}
      }
      if(route===`/api/admin/videos/${s.id}/complete`){s.completed++;const total=Math.ceil(size/CHUNK);for(let n=1;n<=total;n++)if(!s.parts.has(n))return json({error:'Upload is incomplete. Resume uploading first.'},409);return json({status:'ready',thumbnailReady:preview,title:'Fixture',url:`${ORIGIN}/v/${SHARE}`});}
      throw new Error('Unexpected request '+route);
    }};
  return s;
}
const percents=stages=>stages.filter(s=>s.startsWith('Uploading ')).map(s=>Number(/(\d+)%/.exec(s)[1]));

test('uploads parts concurrently within the pool limit and reports byte based progress',async()=>{
  const f=await fixture(12);const s=service(f.size,{latency:n=>n%3?40:5});
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,concurrency:5});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error,undefined);assert.equal(f.rec.state.share.url,`${ORIGIN}/v/${SHARE}`);
  assert.equal(s.maxInFlight,5);assert.deepEqual([...s.puts].sort((a,b)=>a-b),Array.from({length:12},(_,i)=>i+1));
  assert.equal(s.completed,1);
  const p=percents(f.media.stages);assert.equal(p[0],0);assert.equal(p.at(-1),100);assert.deepEqual(p,[...p].sort((a,b)=>a-b));
  assert.ok(p.length>5,'progress advances as parts finish');
  assert.equal(publisher.controller,null);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('resume skips parts the service already has and starts progress from them',async()=>{
  const f=await fixture(6);const s=service(f.size,{stored:[1,2,4]});
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error,undefined);assert.deepEqual([...s.puts].sort(),[3,5,6]);
  assert.equal(percents(f.media.stages)[0],Math.floor(3*CHUNK/f.size*100));
  await fs.rm(f.root,{recursive:true,force:true});
});

test('a paused upload resumes with the same upload ID and skips completed parts',async()=>{
  const f=await fixture(8);let calls=0,slow=true;const s=service(f.size,{latency:()=>slow&&calls++>=4?2000:5});
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,concurrency:2});
  publisher.publish(f.file,'Fixture');
  while(s.parts.size<4||s.inFlight<2)await delay(5);
  f.media.cancelled=true;publisher.cancel();
  const first=await f.media.task;assert.match(first.error.message,/Upload paused/);assert.equal(s.completed,0);
  const id=s.id,done=[...s.parts.keys()];assert.equal(done.length,4);
  f.media.cancelled=false;slow=false;s.puts.length=0;
  // The checkpoint keeps the upload ID, so a new publish resumes the same upload.
  new Publisher(f.rec,f.media,{fetch:s.fetch}).publish(f.file,'Fixture');
  const second=await f.media.task;
  assert.equal(second.error,undefined);assert.equal(s.id,id);
  for(const n of done)assert.ok(!s.puts.includes(n),`part ${n} was not uploaded again`);
  assert.equal(s.parts.size,8);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('temporary part failures retry with backoff and permanent failures stop every in flight part',async()=>{
  let f=await fixture(6);const attempts=new Map();
  let s=service(f.size,{fail:n=>{const a=(attempts.get(n)||0)+1;attempts.set(n,a);return n===3&&a<3?{status:503}:(n===4&&a<2?{status:429}:null);}});
  let publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,retryDelay:5});
  publisher.publish(f.file,'Fixture');let result=await f.media.task;
  assert.equal(result.error,undefined);assert.equal(attempts.get(3),3);assert.equal(attempts.get(4),2);assert.equal(s.completed,1);
  await fs.rm(f.root,{recursive:true,force:true});

  f=await fixture(10);
  s=service(f.size,{fail:n=>n===2?{status:400,error:'Upload part has the wrong size.'}:null,latency:n=>n===2?5:500});
  publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,concurrency:4,retryDelay:5});
  publisher.publish(f.file,'Fixture');result=await f.media.task;
  assert.equal(result.error.message,'Upload part has the wrong size.');
  assert.equal(s.puts.filter(n=>n===2).length,1,'client errors are not retried');
  assert.equal(s.aborted,s.puts.length-1,'every other started part was aborted');assert.ok(s.aborted>=1);assert.equal(s.completed,0);
  assert.ok(s.puts.length<=4,'no new parts start after a failure');
  await fs.rm(f.root,{recursive:true,force:true});

  f=await fixture(3);
  s=service(f.size,{fail:n=>n===2?{status:502}:null});
  publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,retryDelay:1});
  publisher.publish(f.file,'Fixture');result=await f.media.task;
  assert.equal(s.puts.filter(n=>n===2).length,4,'retries stop after four attempts');assert.ok(result.error);assert.equal(s.completed,0);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('cancel aborts all in flight requests and does not finish the upload',async()=>{
  const f=await fixture(9);const s=service(f.size,{latency:()=>10000});
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,concurrency:5});
  const started=Date.now();publisher.publish(f.file,'Fixture');
  while(s.inFlight<5)await delay(5);
  f.media.cancelled=true;publisher.cancel();const result=await f.media.task;
  assert.equal(result.error.message,'Upload paused. Share this recording again to resume.');
  assert.equal(s.aborted,5);assert.ok(s.signals.every(signal=>signal.aborted));assert.equal(s.puts.length,5);assert.equal(s.completed,0);
  assert.ok(Date.now()-started<3000,'cancel does not wait for slow parts');
  await fs.rm(f.root,{recursive:true,force:true});
});

test('a recording that changes during upload is rejected',async()=>{
  const f=await fixture(6);let touched=false;
  const s=service(f.size,{latency:n=>{if(n===2&&!touched){touched=true;fs.appendFile(f.file,'x');}return 20;}});
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,concurrency:2});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error.message,'The recording changed during upload.');assert.equal(s.completed,0);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('a failed preview still completes publishing and exposes the share link with a clear note',async()=>{
 const f=await fixture(1),s=service(f.size,{preview:false}),publisher=new Publisher(f.rec,f.media,{fetch:s.fetch});
 publisher.uploadThumbnail=async()=>{throw new Error('Preview unavailable');};
 try{publisher.publish(f.file,'Fixture');const result=await f.media.task;assert.equal(result.error,undefined);assert.equal(s.completed,1);assert.equal(f.rec.state.share.url,`${ORIGIN}/v/${SHARE}`);assert.equal(f.rec.state.share.thumbnailReady,false);assert.match(f.rec.state.share.cardWarning,/Video ready/);}
 finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('canceling while a preview is being created does not publish an unfinished upload',async()=>{
 const f=await fixture(1),s=service(f.size,{preview:false}),publisher=new Publisher(f.rec,f.media,{fetch:s.fetch});
 publisher.uploadThumbnail=async()=>{f.media.cancelled=true;throw new Error('Canceled');};
 try{publisher.publish(f.file,'Fixture');const result=await f.media.task;assert.match(result.error.message,/Upload paused/);assert.equal(s.completed,0);assert.equal(f.rec.state.share,null);}
 finally{await fs.rm(f.root,{recursive:true,force:true});}
});


test('self-hosted sharing binds its key to an HTTPS origin and rejects unsafe configuration',async()=>{
 const f=await fixture(1);const config=path.join(f.rec.dataDir,'publishing.json');
 try{
  const origin='https://videos.example.org';
  await fs.writeFile(config,JSON.stringify({origin,token:TOKEN}));
  let requested;
  const publisher=new Publisher(f.rec,f.media,{fetch:async(url,options)=>{requested={url,options};return Response.json({url:origin+'/connect#code'});}});
  await publisher.init();assert.equal(f.rec.state.publishingReady,true);
  assert.equal(await publisher.libraryURL(),origin+'/connect#code');
  assert.equal(requested.url,origin+'/api/admin/browser-session');
  assert.equal(requested.options.headers.Authorization,'Bearer '+TOKEN);
  await fs.writeFile(config,JSON.stringify({origin:'https://changed.example.org',token:TOKEN}));
  await assert.rejects(publisher.libraryURL(),/Restart VidCapture/);
  for(const bad of ['http://videos.example.org','https://user:password@videos.example.org','https://videos.example.org/path','https://videos.example.org/']){
   await fs.writeFile(config,JSON.stringify({origin:bad,token:TOKEN}));
   await publisher.init();assert.equal(f.rec.state.publishingReady,false,bad);
  }
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('sharing without a connection opens the site, waits for approval, then saves a private token',async()=>{
 const f=await fixture(1);const config=path.join(f.rec.dataDir,'publishing.json');await fs.rm(config);
 try{
  const opened=[],seen=[];let hash,polls=0,token;
  const s=service(f.size);
  const fetch=async(url,options)=>{
   const route=url.slice(ORIGIN.length);seen.push(route);
   if(route==='/api/pair/start'){assert.equal(options.headers.Authorization,undefined);const body=JSON.parse(options.body);hash=body.hash;assert.match(hash,/^[a-f0-9]{64}$/);assert.ok(body.name);return Response.json({url:ORIGIN+'/connect-app#'+'c'.repeat(32),code:'AB2C-DE3F'});}
   if(route==='/api/pair/status'){token=options.headers.Authorization.slice(7);assert.equal(require('node:crypto').createHash('sha256').update(token).digest('hex'),hash);return Response.json({status:++polls<3?'pending':'approved'});}
   return s.fetch(url,{...options,headers:{...options.headers,Authorization:`Bearer ${TOKEN}`}});
  };
  const publisher=new Publisher(f.rec,f.media,{fetch,openExternal:async url=>opened.push(url),pairInterval:1});
  await publisher.init();assert.equal(f.rec.state.publishingReady,false);
  publisher.publish(f.file,'Fixture');const {error}=await f.media.task;assert.ifError(error);
  assert.deepEqual(opened,[ORIGIN+'/connect-app#'+'c'.repeat(32)]);
  assert.ok(f.media.stages.some(x=>x.includes('AB2C-DE3F')));assert.equal(polls,3);assert.equal(f.rec.state.publishingReady,true);
  const saved=JSON.parse(await fs.readFile(config,'utf8'));assert.deepEqual(saved,{origin:ORIGIN,token});
  assert.equal((await fs.stat(config)).mode&0o777,0o600);
  assert.ok(f.rec.state.share.url.startsWith(ORIGIN+'/v/'));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('an expired connection request stops with a clear message and saves nothing',async()=>{
 const f=await fixture(1);const config=path.join(f.rec.dataDir,'publishing.json');await fs.rm(config);
 try{
  const fetch=async url=>url.endsWith('/api/pair/start')?Response.json({url:ORIGIN+'/connect-app#'+'d'.repeat(32),code:'AB2C-DE3F'}):Response.json({status:'expired'});
  const publisher=new Publisher(f.rec,f.media,{fetch,openExternal:async()=>{},pairInterval:1});
  publisher.publish(f.file,'Fixture');const {error}=await f.media.task;assert.match(error.message,/expired/);
  await assert.rejects(fs.access(config));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('a link to another site is never opened during connection',async()=>{
 const f=await fixture(1);await fs.rm(path.join(f.rec.dataDir,'publishing.json'));
 try{
  const opened=[];const publisher=new Publisher(f.rec,f.media,{fetch:async()=>Response.json({url:'https://evil.example/connect-app#x',code:'AB2C-DE3F'}),openExternal:async u=>opened.push(u),pairInterval:1});
  publisher.publish(f.file,'Fixture');const {error}=await f.media.task;assert.match(error.message,/Invalid connection/);assert.deepEqual(opened,[]);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('captions for the shared cut upload after the video completes',async()=>{
  const f=await fixture(2);const s=service(f.size);const captions=[];
  const fetch=async(url,options)=>{
    const route=url.slice(ORIGIN.length);
    if(/\/captions$/.test(route)){assert.equal(s.completed,1,'after complete');assert.equal(options.method,'PUT');assert.equal(options.headers['Content-Type'],'text/vtt');captions.push(String(options.body));return new Response('{"ok":true}');}
    return s.fetch(url,options);
  };
  // The fixture's whole duration is kept, so no edited copy is made.
  const transcript=async file=>{assert.equal(file,f.file);return {transcript:{words:[{text:'Hello',start:1,end:1.4},{text:'world.',start:1.5,end:2}]}};};
  const publisher=new Publisher(f.rec,f.media,{fetch,transcript});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error,undefined);assert.equal(captions.length,1);
  assert.ok(captions[0].startsWith('WEBVTT'));assert.match(captions[0],/00:00:01\.000 --> 00:00:02\.000\nHello world\./);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('a failed caption upload does not fail the share',async()=>{
  const f=await fixture(2);const s=service(f.size);const logged=[];
  const fetch=async(url,options)=>/\/captions$/.test(url)?new Response('{"error":"Too large."}',{status:413}):s.fetch(url,options);
  const publisher=new Publisher(f.rec,f.media,{fetch,transcript:async()=>({transcript:{words:[{text:'Hi.',start:0,end:1}]}}),log:(...a)=>logged.push(a.join(' '))});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error,undefined);assert.equal(f.rec.state.share.url,`${ORIGIN}/v/${SHARE}`);
  assert.equal(logged.length,1);assert.match(logged[0],/Too large/);
  await fs.rm(f.root,{recursive:true,force:true});
});

test('no transcript means no caption request',async()=>{
  const f=await fixture(2);const s=service(f.size);
  const publisher=new Publisher(f.rec,f.media,{fetch:s.fetch,transcript:async()=>({transcript:null})});
  publisher.publish(f.file,'Fixture');const result=await f.media.task;
  assert.equal(result.error,undefined);
  await fs.rm(f.root,{recursive:true,force:true});
});
