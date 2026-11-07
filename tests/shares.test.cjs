const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {Publisher,ORIGIN}=require('../publisher.cjs');
const {planKey,shareView,updateMeta,readMeta}=require('../shares.cjs');
const TOKEN='a'.repeat(64),SHARE='c'.repeat(48),ID='11111111-2222-3333-4444-555555555555';

async function setup(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-share-test-'));
  const dataDir=path.join(root,'state'),outputDir=path.join(root,'videos');await fs.mkdir(dataDir);await fs.mkdir(outputDir);
  await fs.writeFile(path.join(dataDir,'publishing.json'),JSON.stringify({token:TOKEN,origin:ORIGIN}),{mode:0o600});
  const file=path.join(outputDir,'Demo 2026-11-07 10.00.mp4');await fs.writeFile(file,Buffer.alloc(1000,1));
  const rec={dataDir,outputDir,state:{publishingReady:true},set(o){Object.assign(this.state,o);},allowedFile:async f=>f};
  const media={cancelled:false,stages:[],task:null,
    startJob(kind,stage,work){this.task=work().then(output=>({output}),error=>({error}));return {};},
    stage(s){this.stages.push(s);},
    getMedia:async()=>({duration:60,width:1920,height:1080,keep:[[0,60]]}),metadata:async()=>({}),
    probe:async()=>({streams:[{codec_type:'video',codec_name:'h264'}]})};
  return {root,dataDir,outputDir,file,rec,media};
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});

test('plan keys treat the whole recording the same however it is written',()=>{
  assert.equal(planKey(undefined,60),'full');
  assert.equal(planKey([[0,60]],60),'full');
  assert.equal(planKey([[0.004,59.995]],60),'full');
  assert.notEqual(planKey([[0,30],[40,60]],60),'full');
  assert.equal(planKey([[0,30.00049],[40,60]],60),planKey([[0,30],[40,60]],60));
});

test('the share view says when edits changed after the link was made',()=>{
  const share={id:ID,url:`${ORIGIN}/v/${SHARE}`,title:'Demo',planKey:'full',duration:60};
  assert.deepEqual(shareView({share,keep:[[0,60]]},ORIGIN).current,true);
  assert.equal(shareView({share,keep:[[0,20],[30,60]]},ORIGIN).current,false);
  assert.equal(shareView({share:{...share,url:'https://evil.example/v/x'}},ORIGIN),null,'links for other sites are ignored');
  assert.equal(shareView({},ORIGIN),null);
});

test('sidecar updates keep the other fields',async()=>{
  const f=await setup();const name=path.basename(f.file);
  await fs.writeFile(path.join(f.dataDir,name+'.json'),JSON.stringify({keep:[[0,10]],currentVersion:{suffix:'',at:1},title:'Demo'}));
  await updateMeta(f.dataDir,name,m=>{m.share={id:ID};});
  assert.deepEqual(await readMeta(f.dataDir,name),{keep:[[0,10]],currentVersion:{suffix:'',at:1},title:'Demo',share:{id:ID}});
});

test('sharing a recording that already has a link does not upload it again',async()=>{
  const f=await setup();const name=path.basename(f.file);const calls=[];
  await updateMeta(f.dataDir,name,m=>{m.share={id:ID,url:`${ORIGIN}/v/${SHARE}`,title:'Old title',planKey:'full',duration:60};});
  const fetch=async(url,options)=>{const route=url.slice(ORIGIN.length);calls.push([options.method||'GET',route]);
    if(route===`/api/admin/videos/${ID}`&&!options.method)return json({id:ID,status:'ready',title:'Old title',url:`${ORIGIN}/v/${SHARE}`,thumbnailReady:true});
    if(route===`/api/admin/videos/${ID}`&&options.method==='PATCH')return json({id:ID,status:'ready',title:JSON.parse(options.body).title,url:`${ORIGIN}/v/${SHARE}`});
    throw new Error('Unexpected '+route);};
  const p=new Publisher(f.rec,f.media,{fetch});
  p.publish(f.file,'New title');const r=await f.media.task;
  assert.equal(r.error,undefined);
  assert.deepEqual(calls.map(c=>c[0]),['GET','PATCH'],'checked and retitled, nothing uploaded');
  assert.equal(f.rec.state.share.url,`${ORIGIN}/v/${SHARE}`);
  assert.equal((await readMeta(f.dataDir,name)).share.title,'New title');
});

test('a link removed online is forgotten and the recording uploads again',async()=>{
  const f=await setup();const name=path.basename(f.file);const routes=[];
  await updateMeta(f.dataDir,name,m=>{m.share={id:ID,url:`${ORIGIN}/v/${SHARE}`,title:'Demo',planKey:'full',duration:60};});
  let newId=null;
  const fetch=async(url,options)=>{const route=url.slice(ORIGIN.length);routes.push(route);
    if(route===`/api/admin/videos/${ID}`)return json({error:'Video not found.'},404);
    if(route==='/api/admin/uploads'){newId=JSON.parse(options.body).id;return json({status:'uploading',thumbnailReady:true,chunkSize:8*1024*1024,parts:[]});}
    if(/\/parts\/1$/.test(route))return json({partNumber:1,etag:'e'});
    if(route===`/api/admin/videos/${newId}/complete`)return json({status:'ready',thumbnailReady:true,title:'Demo',url:`${ORIGIN}/v/${'d'.repeat(48)}`});
    throw new Error('Unexpected '+route);};
  const p=new Publisher(f.rec,f.media,{fetch});
  p.publish(f.file,'Demo');const r=await f.media.task;
  assert.equal(r.error,undefined);
  assert.ok(routes.includes('/api/admin/uploads'));
  const share=(await readMeta(f.dataDir,name)).share;
  assert.equal(share.id,newId);assert.equal(share.url,`${ORIGIN}/v/${'d'.repeat(48)}`);assert.equal(share.planKey,'full');
});

test('a new upload saves its link on the recording',async()=>{
  const f=await setup();const name=path.basename(f.file);let id;
  const fetch=async(url,options)=>{const route=url.slice(ORIGIN.length);
    if(route==='/api/admin/uploads'){id=JSON.parse(options.body).id;return json({status:'uploading',thumbnailReady:true,chunkSize:8*1024*1024,parts:[]});}
    if(/\/parts\/1$/.test(route))return json({partNumber:1,etag:'e'});
    if(route===`/api/admin/videos/${id}/complete`)return json({status:'ready',thumbnailReady:true,title:'Demo',url:`${ORIGIN}/v/${SHARE}`});
    throw new Error('Unexpected '+route);};
  const p=new Publisher(f.rec,f.media,{fetch});
  p.publish(f.file,'Demo');assert.equal((await f.media.task).error,undefined);
  const view=shareView(await readMeta(f.dataDir,name),ORIGIN);
  assert.equal(view.url,`${ORIGIN}/v/${SHARE}`);assert.equal(view.current,true);
});

test('sync clears links deleted online and finds older uploads after a rename',async()=>{
  const f=await setup();
  const gone=path.join(f.outputDir,'Gone 2026-11-06 09.00.mp4');await fs.writeFile(gone,Buffer.alloc(10));
  await updateMeta(f.dataDir,path.basename(gone),m=>{m.share={id:'99999999-2222-3333-4444-555555555555',url:`${ORIGIN}/v/${'e'.repeat(48)}`,planKey:'full'};});
  // An upload made before share records existed, under the file's old name.
  const st=await fs.stat(f.file);
  await fs.mkdir(path.join(f.dataDir,'uploads'));
  await fs.writeFile(path.join(f.dataDir,'uploads','x.json'),JSON.stringify({id:ID,file:path.join(f.outputDir,'Capture-2026-11-07T10-00-00-000Z.mp4'),original:'old',size:st.size,mtime:st.mtimeMs}));
  const fetch=async url=>{assert.equal(url,`${ORIGIN}/api/admin/videos`);return json({videos:[{id:ID,status:'ready',title:'Demo',url:`${ORIGIN}/v/${SHARE}`,duration:60,publishedAt:1794000000}]});};
  const p=new Publisher(f.rec,f.media,{fetch});
  assert.deepEqual(await p.syncShares(),{synced:true,changed:2});
  assert.equal((await readMeta(f.dataDir,path.basename(gone))).share,undefined);
  const found=(await readMeta(f.dataDir,path.basename(f.file))).share;
  assert.equal(found.id,ID);assert.equal(found.url,`${ORIGIN}/v/${SHARE}`);assert.equal(found.sharedAt,new Date(1794000000*1000).toISOString());
  assert.deepEqual(await p.syncShares(),{synced:true,changed:0},'a second sync changes nothing');
});
